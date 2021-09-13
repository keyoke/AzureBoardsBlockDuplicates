import * as SDK from "azure-devops-extension-sdk";
import { CommonServiceIds, getClient, IProjectInfo, IProjectPageService, ILocationService } from "azure-devops-extension-api";
import { IWorkItemFormService, WorkItemQueryResult, WorkItemReference, WorkItemTrackingRestClient, WorkItemTrackingServiceIds, IWorkItemNotificationListener } from "azure-devops-extension-api/WorkItemTracking";
import * as stringSimilarity from "string-similarity";
import * as striptags from "striptags";

class duplicateObserver implements IWorkItemNotificationListener  {
    _similarityIndex : number = 0.8;
    _workItemFormService: IWorkItemFormService;
    _locationService: ILocationService;
    _projectService: IProjectPageService;
    _timeout: NodeJS.Timeout;

    constructor(workItemFormService: IWorkItemFormService, locationService: ILocationService, projectService: IProjectPageService) {
        this._workItemFormService = workItemFormService;
        this._locationService = locationService;
        this._projectService = projectService;
    }

    // main entrypoint for validation logic 
    public async validateWorkItem() {
        // Get the Orgs Base url for WIT Rest Calls
        const hostBaseUrl = await this._locationService.getResourceAreaLocation(
            '5264459e-e5e0-4bd8-b118-0985e68a4ec5' // WIT
        );

        // Get The current ADO Project we need the project name later
        const project = await this._projectService.getProject();

        // Get The WIT rest client
        const client: WorkItemTrackingRestClient = getClient(WorkItemTrackingRestClient);

        // We need a few fields from the current workitem to perform our similairty analysis
        const id: string = await this._workItemFormService.getFieldValue("System.Id", { returnOriginalValue: false }) as string;
        const title: string = await this._workItemFormService.getFieldValue("System.Title", { returnOriginalValue: false }) as string;
        const description: string = striptags(await this._workItemFormService.getFieldValue("System.Description", { returnOriginalValue: false }) as string);
        const type: string = await this._workItemFormService.getFieldValue("System.WorkItemType", { returnOriginalValue: false }) as string;

        // Search for existing WI's which are not closed and are of the same type of the current WI
        const wiqlResult: WorkItemQueryResult = await client.queryByWiql({
            query: `SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] = \'${type}\' AND [State] <> \'Closed\' ORDER BY [System.CreatedDate] DESC`
        }, project.name);

        // Process the returned WI's in batches of 200
        let promises: Array<Promise<boolean>> = [], i : number, j : number, chunk_items : Array<WorkItemReference>, chunk : number = 200;
        for (i = 0, j = wiqlResult.workItems.length; i < j; i += chunk) {
            // Get The current batch
            chunk_items = wiqlResult.workItems.slice(i, i + chunk);
            // Setup our batch request payload we dont want everything only certain fields
            promises.push(this.validateWorkItemChunk(hostBaseUrl, project.name, id, title, description, chunk_items));
        }

        // Wait for any one of our promises to return bool(true) result then continue
        const duplicate: boolean = await this.getfirstResolvedPromise(promises);

        // Check if we have any other invalid fields
        const invalidFields = await this._workItemFormService.getInvalidFields();

        // Debugging
        invalidFields.forEach(invalid => {
            console.log(`Invalid Field '${invalid.description}'.`);
        });

        // Show standard invalid field message if required
        if (invalidFields.length > 0) {
            // There are other invalid fields so skip checks and don't overwrite work item rule errors
            console.log(`Skip checks as we already have invalid fields.`);
            return;
        }

        // did we find any duplicates?
        if (duplicate) {
            console.log(`Duplicate Work item.`);
            this._workItemFormService.setError(`Duplicate Work item.`);
        }
        else {
            console.log(`Not a Duplicate Work item.`);
            this._workItemFormService.clearError();
        }
    }

    // perform similarity logic on a batch of WI's
    private async validateWorkItemChunk(hostBaseUrl: string, projectName: string, currentWorkItemId: string, currentWorkItemTitle: string, currentWorkItemDescription: string, workItemsChunk: Array<WorkItemReference>): Promise<boolean> {
        // Prepare our request body for this batch, only request title and description
        const requestBody = {
            "ids": workItemsChunk.map(workitem => { return workitem.id; }),
            "$expand": "None",
            "fields": [
                "System.Id",
                "System.Title",
                "System.Description"
            ]
        }

        // Get a valid access token for our batch request
        const accessToken = await SDK.getAccessToken();

        // return a promise
        return new Promise<boolean>(async (resolve, reject) => {
            try {
                // Get our WorkItem data using the batch api
                const response = await fetch(`${hostBaseUrl}${projectName}/_apis/wit/workitemsbatch?api-version=6.0`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(requestBody)
                })

                // Get The JSON response
                let workitems: any = await response.json();
                // console.dir(workitems);

                let duplicate: boolean = false;
                // Enumerate returned WI's and check for similarity of X 
                workitems.value.every((workitem: any) => {
                    // Ignore the current WI if editing an existing one
                    if (currentWorkItemId &&
                        workitem.id !== currentWorkItemId) {
                        // First check the titles
                        var title_similarity: number = stringSimilarity.compareTwoStrings(currentWorkItemTitle, workitem.fields['System.Title']);

                        // Did we hit the threshold for Similarity Index
                        if (title_similarity >= this._similarityIndex) {
                            // return result and stop processing items
                            duplicate = true;
                            return false;
                        }
                        else {
                            // then check the the description
                            var description_similarity: number = stringSimilarity.compareTwoStrings(currentWorkItemDescription, striptags(workitem.fields['System.Description']));

                            // Did we hit the threshold for Similarity Index
                            if (description_similarity >= this._similarityIndex) {
                                // return result and stop processing items
                                duplicate = true;
                                return false;
                            }
                        }
                    }

                    // continue processing items as we have not found duplicate yet
                    return true;
                });

                // Resolve our promise
                resolve(duplicate);
            }
            catch(error){
                // unhandled error
                reject(false);
                console.error(error);
            }
        });
    }

    // function to get first promise which resolves to true result
    private async getfirstResolvedPromise(promises: Array<Promise<boolean>>) : Promise<boolean>{
        const newPromises : Promise<boolean>[] = promises.map(p => new Promise<boolean>(
            (resolve, reject) => p.then(v => v && resolve(true), reject)
          ));
          newPromises.push(Promise.all(promises).then(() => false));
          return Promise.race(newPromises);
    }

    // Called when the active work item is modified
    public async onFieldChanged(args: any) {
        console.log(`WorkItemForm.onFieldChanged().`);

        // when changes are made wait a bit before triggering the validation
        if (this._timeout) clearTimeout(this._timeout);
        console.log(`Setting timer for triggering validation.`);
        this._timeout = setTimeout(() => {
            console.log(`Triggering validation.`);
            this.validateWorkItem();
        }, 3000);
    }

    // Called when a new work item is being loaded in the UI
    public async onLoaded(args: any) {
        console.log(`WorkItemForm.onLoaded().`);
        this.validateWorkItem();
    }

    // Called when the active work item is being unloaded in the UI
    public async onUnloaded(args: any) {
        console.log(`WorkItemForm.onUnloaded().`);
    }

    // Called after the work item has been saved
    public async onSaved(args: any) {
        console.log(`WorkItemForm.onSaved().`);
    }

    // Called when the work item is reset to its unmodified state (undo)
    public async onReset(args: any) {
        console.log(`WorkItemForm.onReset().`);
    }

    // Called when the work item has been refreshed from the server
    public async onRefreshed(args: any) {
        console.log(`WorkItemForm.onRefreshed().`);
        this.validateWorkItem();
    }
}

const main = async () =>{
    await SDK.init(<SDK.IExtensionInitOptions>{ 
        explicitNotifyLoaded: true 
    });

    // wait until we are ready
    await SDK.ready();

    // soft-cor.block-duplicate-work-items.block-duplicate-observer or block-duplicate-observer ??
    const contributionId : string = SDK.getContributionId();
    // Get The ADO Services which we will need later
    const locationService: ILocationService = await SDK.getService(CommonServiceIds.LocationService);
    const projectService: IProjectPageService = await SDK.getService<IProjectPageService>(CommonServiceIds.ProjectPageService);
    const workItemFormService: IWorkItemFormService = await SDK.getService<IWorkItemFormService>(WorkItemTrackingServiceIds.WorkItemFormService);
    const observer: duplicateObserver = new duplicateObserver(workItemFormService, locationService, projectService);

    console.log(contributionId);
    
    // Register our contribution
    SDK.register(contributionId, () => {
        // Get the Work Item Form Service
        return observer;
    });

    // notify we are loaded
    await SDK.notifyLoadSucceeded();
};

// execute our entrypoint
main().catch((error) => { console.error(error); });