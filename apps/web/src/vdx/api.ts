/**
 * Thin HTTP + SSE client for the agent server (http://localhost:8790).
 * Every call throws an Error with a message good enough to show in chat.
 */

import { API_BASE } from "./lib";
import type {
  CanvasItemView,
  CanvasResponse,
  CreateProjectRequest,
  CreateProjectResponse,
  EditResponse,
  JobEvent,
  LibraryResponse,
  ProjectListItem,
  ProjectResponse,
  TakesResponse,
  UploadResponse,
} from "./types";

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method ?? "GET";
  // FormData bodies must let the browser set the multipart boundary itself.
  const isForm = init?.body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        ...(isForm ? {} : { "content-type": "application/json" }),
        ...(init?.headers as Record<string, string>),
      },
    });
  } catch {
    throw new Error(`Cannot reach the agent server at ${API_BASE} — is it running?`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `${method} ${path} → ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 300)}` : ""}`,
    );
  }
  return (await res.json()) as T;
}

export const api = {
  createProject(request: CreateProjectRequest): Promise<CreateProjectResponse> {
    return http("/api/projects", { method: "POST", body: JSON.stringify(request) });
  },

  /** Empty project (no director run) — the landing spot for pre-brief uploads. */
  createDraftProject(name?: string): Promise<{ projectId: string }> {
    return http("/api/projects/draft", {
      method: "POST",
      body: JSON.stringify(name ? { name } : {}),
    });
  },

  approveJob(jobId: string): Promise<{ ok: true }> {
    return http(`/api/jobs/${encodeURIComponent(jobId)}/approve`, { method: "POST" });
  },

  uploadFiles(
    files: File[],
    opts: { projectId?: string; purpose?: "brief" | "reference" } = {},
  ): Promise<UploadResponse> {
    const form = new FormData();
    for (const file of files) form.append("files", file, file.name);
    if (opts.projectId) form.append("projectId", opts.projectId);
    if (opts.purpose) form.append("purpose", opts.purpose);
    return http("/api/uploads", { method: "POST", body: form });
  },

  listProjects(): Promise<{ projects: ProjectListItem[] }> {
    return http("/api/projects");
  },

  getProject(id: string): Promise<ProjectResponse> {
    return http(`/api/projects/${encodeURIComponent(id)}`);
  },

  getLibrary(id: string): Promise<LibraryResponse> {
    return http(`/api/projects/${encodeURIComponent(id)}/library`);
  },

  getCanvas(id: string): Promise<CanvasResponse> {
    return http(`/api/projects/${encodeURIComponent(id)}/canvas`);
  },

  moveCanvasItem(
    id: string,
    itemId: string,
    patch: { x?: number; y?: number; w?: number; h?: number; z?: number },
  ): Promise<{ item: CanvasItemView }> {
    return http(`/api/projects/${encodeURIComponent(id)}/canvas/${encodeURIComponent(itemId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  },

  addCanvasNote(
    id: string,
    note: { text: string; x: number; y: number },
  ): Promise<{ item: CanvasItemView }> {
    return http(`/api/projects/${encodeURIComponent(id)}/canvas/notes`, {
      method: "POST",
      body: JSON.stringify(note),
    });
  },

  getTakes(id: string): Promise<TakesResponse> {
    return http(`/api/projects/${encodeURIComponent(id)}/takes`);
  },

  selectTake(id: string, takeId: string): Promise<{ summary: string }> {
    return http(
      `/api/projects/${encodeURIComponent(id)}/takes/${encodeURIComponent(takeId)}/select`,
      { method: "POST" },
    );
  },

  retakeShot(id: string, shotId: string, promptTweak?: string): Promise<{ jobId: string }> {
    return http(
      `/api/projects/${encodeURIComponent(id)}/shots/${encodeURIComponent(shotId)}/retake`,
      { method: "POST", body: JSON.stringify(promptTweak ? { promptTweak } : {}) },
    );
  },

  edit(id: string, instruction: string): Promise<EditResponse> {
    return http(`/api/projects/${encodeURIComponent(id)}/edit`, {
      method: "POST",
      body: JSON.stringify({ instruction }),
    });
  },

  undo(id: string): Promise<{ summary: string }> {
    return http(`/api/projects/${encodeURIComponent(id)}/undo`, { method: "POST" });
  },

  redo(id: string): Promise<{ summary: string }> {
    return http(`/api/projects/${encodeURIComponent(id)}/redo`, { method: "POST" });
  },

  render(id: string, draft: boolean): Promise<{ jobId: string }> {
    return http(`/api/projects/${encodeURIComponent(id)}/render`, {
      method: "POST",
      body: JSON.stringify({ draft }),
    });
  },
};

export interface StreamHandlers {
  onEvent: (event: JobEvent) => void;
  /** Called exactly once when the stream ends; `error` set on failure. */
  onEnd: (error?: string) => void;
}

/**
 * Subscribe to a job's SSE stream. Returns a cancel function. The stream is
 * closed on `done`/`error` events; if the server closes the connection
 * without a terminal event we end quietly (jobs may finish with
 * `render_done` alone) unless nothing was ever received. `awaiting_approval`
 * is NOT terminal — the same stream continues after the job is approved.
 */
export function streamJob(jobId: string, handlers: StreamHandlers): () => void {
  const source = new EventSource(`${API_BASE}/api/jobs/${encodeURIComponent(jobId)}/stream`);
  let ended = false;
  let sawEvent = false;

  const end = (error?: string) => {
    if (ended) return;
    ended = true;
    source.close();
    handlers.onEnd(error);
  };

  source.onmessage = (msg: MessageEvent<string>) => {
    let event: JobEvent;
    try {
      event = JSON.parse(msg.data) as JobEvent;
    } catch {
      return; // ignore malformed frames (keepalives etc.)
    }
    sawEvent = true;
    handlers.onEvent(event);
    if (event.stage === "done") end();
    else if (event.stage === "error") end(event.message || "job failed");
  };

  source.onerror = () => {
    // EventSource retries forever by default; a job stream that dropped after
    // emitting events has simply finished, so stop rather than reconnect.
    if (sawEvent) end();
    else end(`Lost connection to job ${jobId} — is the agent server running?`);
  };

  return () => end();
}
