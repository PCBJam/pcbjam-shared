# @pcbjam/shared

The **contract** between the [PCBJam](https://github.com/PCBJam/pcbjam)
wasm-frontend (the GPL standalone KiCad editor) and **any** backend that serves
projects to it.

This package is deliberately tiny and MIT-licensed so that anyone can implement a
conforming backend. It defines:

- **The KiCad tool domain** — `TOOLS`, `toolSchema`, `TOOL_LABELS`,
  `EXTENSION_TOOL`, `FILELESS_TOOLS`.
- **The minimum read/load API** a backend must expose for the editor to work — a
  [ts-rest](https://ts-rest.com/) `contract` with `listProjects`, `getProject`,
  and `listFiles`.
- **The shared DTOs** — `Project`, `ProjectFile`, `ProjectWithFiles`, `errorBody`,
  and `projectSlugSchema`.

It does **not** define management/write operations (create, delete, upload),
ownership, or auth — those belong to the application layer that builds on top of
this contract.

## Required binary route

The file-byte download is streamed binary and is intentionally **not** a ts-rest
endpoint. A conforming backend must still expose:

```
GET /api/projects/:project/files/*   →   raw file bytes
```

The editor fetches it directly.

## Usage

```ts
import { contract, type Tool, EXTENSION_TOOL } from "@pcbjam/shared";
import { initClient } from "@ts-rest/core";

const client = initClient(contract, { baseUrl: "http://localhost:3050" });
const res = await client.getProject({ params: { project: "demo" } });
```

## License

MIT — see [LICENSE](./LICENSE).
