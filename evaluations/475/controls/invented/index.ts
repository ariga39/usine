interface PluginHost {
  getState(): { resources: number[] };
}
export class PluginServer {
  constructor(private readonly host: PluginHost) {}
  load() {
    return this.host.getState();
  }
  unload() {}
  settings = [{ key: "port", type: "number" }];
}
export const createPlugin = (host: PluginHost) => new PluginServer(host);
