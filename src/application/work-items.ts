import {
  createWorkItemInputSchema,
  type WorkItem,
  type WorkItemIndex,
  type WorkItemRepository,
} from "../domain/work-item";

export class WorkItemsService {
  constructor(
    private readonly workspace: WorkItemRepository,
    private readonly index: WorkItemIndex,
  ) {}

  async create(input: unknown): Promise<WorkItem> {
    const validatedInput = createWorkItemInputSchema.parse(input);
    const created = await this.workspace.create(validatedInput);
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
