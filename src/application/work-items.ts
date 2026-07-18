import type {
  CreateWorkItemInput,
  WorkItem,
  WorkItemIndex,
  WorkItemRepository,
} from "../domain/work-item";

export class WorkItemsService {
  constructor(
    private readonly workspace: WorkItemRepository,
    private readonly index: WorkItemIndex,
  ) {}

  async create(input: CreateWorkItemInput): Promise<WorkItem> {
    const created = await this.workspace.create(input);
    const durableItems = await this.workspace.list();

    this.index.rebuild(durableItems);

    return created;
  }

  read(workItemId: string): Promise<WorkItem | null> {
    return this.workspace.read(workItemId);
  }

  async list(): Promise<WorkItem[]> {
    return this.index.list();
  }

  async rebuild(): Promise<WorkItem[]> {
    const durableItems = await this.workspace.list();

    this.index.rebuild(durableItems);

    return this.index.list();
  }
}
