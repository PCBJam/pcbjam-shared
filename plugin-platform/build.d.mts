export const WORKER_CSP: string;
export const runtimeHeaders: string;
export function buildPluginRuntime(directory: string): Promise<{
  version: string; base: string; directory: string;
  manifest: {protocolVersion: number; apiVersion: number; quickjsVersion: string; files: Record<string,{sha256:string;bytes:number}>};
}>;
