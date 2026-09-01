export interface ExecutionReference {
  taskId: string;
  role: "implementer" | "reviewer";
  attempt: string;
}

export interface ExecutionHandle {
  reference: ExecutionReference;
  workspace: string;
}

export type ExecutionObservation = "starting" | "running" | "stopped";

export interface ExecutionLifecycle {
  start(
    reference: ExecutionReference,
    stateDirectory: string,
    workspace: string,
  ): Promise<ExecutionHandle>;
  discover(stateDirectory: string, taskId: string): Promise<readonly ExecutionHandle[]>;
  observe(stateDirectory: string, handle: ExecutionHandle): Promise<ExecutionObservation>;
  interrupt(stateDirectory: string, handle: ExecutionHandle): Promise<void>;
  reap(stateDirectory: string, handle: ExecutionHandle): Promise<void>;
}
