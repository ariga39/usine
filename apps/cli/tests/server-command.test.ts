import { Cause, Effect, Exit, Fiber, Runtime } from "effect";
import { afterEach, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { CliFailure } from "../src/cli-failure.js";

const runtime = {
  startUsineServer: vi.fn(),
};

let runServerCommand: typeof import("../src/server-command.js").runServerCommand;

const environment: NodeJS.ProcessEnv = {};

describe("server command lifecycle failures", () => {
  beforeAll(async () => {
    vi.doMock("@usine/runtime", () => runtime);
    runServerCommand = (await import("../src/server-command.js")).runServerCommand;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    runtime.startUsineServer.mockReset();
    process.exitCode = undefined;
  });

  test("projects an acquisition defect through the structured CLI failure", async () => {
    runtime.startUsineServer.mockRejectedValue(
      new Error("listen EADDRINUSE internal-detail-secret"),
    );
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await Effect.runPromise(runServerCommand(environment));

    expect(stderr).toHaveBeenCalledOnce();
    expect(stderr.mock.calls[0]?.[0]).toBe(
      '{"error":"server_failed","kind":"server","message":"operation failed"}\n',
    );
    expect(process.exitCode).toBe(6);
  });

  test("projects a release defect after awaiting the scoped release", async () => {
    let closeStarted: (() => void) | undefined;
    const closeCalled = new Promise<void>((resolve) => {
      closeStarted = resolve;
    });
    let release: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime.startUsineServer.mockResolvedValue({
      url: "http://127.0.0.1:8787",
      close: vi.fn(async () => {
        closeStarted?.();
        await released;
        throw new Error("release leaked internal-detail-secret");
      }),
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const fiber = Effect.runFork(runServerCommand(environment));

    await vi.waitFor(() => expect(runtime.startUsineServer).toHaveBeenCalledOnce());
    const completed = Effect.runPromise(Fiber.await(fiber));
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
    await closeCalled;
    release?.();
    await interrupted;
    const exit = await completed;

    expect(stdout).toHaveBeenCalledOnce();
    expect(stderr).toHaveBeenCalledOnce();
    expect(stderr.mock.calls[0]?.[0]).toBe(
      '{"error":"server_failed","kind":"server","message":"operation failed"}\n',
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.squash(exit.cause);
      expect(failure).toBeInstanceOf(CliFailure);
      expect(Runtime.getErrorExitCode(failure)).toBe(6);
      expect(Runtime.getErrorReported(failure)).toBe(false);
    }
  });
});
