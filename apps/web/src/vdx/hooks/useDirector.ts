/**
 * useDirector — all UI state for the chat + panels page.
 *
 * First chat message creates (or reuses a draft) project and follows the
 * director job's SSE stream; later messages are conversational edits. Render
 * and retake jobs stream the same way. Uploads land in a draft project when
 * none exists yet. The timeline + library/canvas/takes panels are refreshed
 * (throttled) as job events arrive and always once a job settles.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, streamJob } from "../api";
import { resolveMediaUrl } from "../lib";
import type {
  CanvasItemView,
  ChatMessage,
  ChatMessageInput,
  JobEvent,
  LibraryResponse,
  Plan,
  ProjectListItem,
  RenderInfo,
  SettingsResponse,
  TakeInfo,
  TProject,
  UpdateSettingsRequest,
} from "../types";

const REFRESH_THROTTLE_MS = 1200;

let messageSeq = 0;
const nextId = () => `m${++messageSeq}`;

function eventStatusText(event: JobEvent): string {
  switch (event.stage) {
    case "keyframe":
    case "clip":
    case "retake":
      return `[${event.stage} ${event.shotId}] ${event.message}`;
    case "plan_ready":
      return event.message ?? "Plan ready";
    case "render_done":
      return event.message ?? "Render finished";
    default:
      return event.message;
  }
}

export interface DirectorApi {
  messages: ChatMessage[];
  projects: ProjectListItem[];
  projectId: string | null;
  project: TProject | null;
  plan: Plan | null;
  renders: RenderInfo[];
  latestRenderUrl: string | null;
  library: LibraryResponse | null;
  canvasItems: CanvasItemView[];
  takes: TakeInfo[];
  busy: boolean;
  uploading: boolean;
  jobStatus: string | null;
  /** Job id currently paused at the plan-approval gate, if any. */
  awaitingApprovalJobId: string | null;
  /** Last `done` event summary (shots/cost/duration) — shown persistently. */
  doneSummary: string | null;
  send: (text: string, opts?: { gate?: boolean }) => void;
  approvePlan: () => void;
  upload: (files: File[], asBrief: boolean) => void;
  retake: (shotId: string, promptTweak?: string) => void;
  selectTake: (takeId: string) => void;
  moveCanvasItem: (
    itemId: string,
    pos: { x?: number; y?: number; w?: number; h?: number; z?: number },
  ) => Promise<void>;
  addCanvasNote: (text: string, x: number, y: number) => Promise<void>;
  undo: () => void;
  redo: () => void;
  render: (draft: boolean) => void;
  loadProject: (id: string) => void;
  refreshProjectList: () => void;
  /** Create a fresh draft project and make it active — the "+ New Project" action. */
  newProject: () => void;
  renameProject: (id: string, name: string) => Promise<boolean>;
  /** Resolves the new project's id (or null on failure); also loads it. */
  duplicateProject: (id: string) => Promise<string | null>;
  /** Clears the active project view if the deleted project was open. */
  deleteProject: (id: string) => Promise<boolean>;
  settings: SettingsResponse | null;
  settingsLoading: boolean;
  settingsSaving: boolean;
  settingsError: string | null;
  loadSettings: () => void;
  /** Resolves true on success (settings state is updated); false on failure (settingsError is set). */
  saveSettings: (patch: UpdateSettingsRequest) => Promise<boolean>;
}

export function useDirector(): DirectorApi {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [project, setProject] = useState<TProject | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [renders, setRenders] = useState<RenderInfo[]>([]);
  const [renderOverrideUrl, setRenderOverrideUrl] = useState<string | null>(null);
  const [library, setLibrary] = useState<LibraryResponse | null>(null);
  const [canvasItems, setCanvasItems] = useState<CanvasItemView[]>([]);
  const [takes, setTakes] = useState<TakeInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [jobStatus, setJobStatus] = useState<string | null>(null);
  const [awaitingApprovalJobId, setAwaitingApprovalJobId] = useState<string | null>(null);
  const [doneSummary, setDoneSummary] = useState<string | null>(null);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const projectIdRef = useRef<string | null>(null);
  const planRef = useRef<Plan | null>(null);
  const stopStreamRef = useRef<(() => void) | null>(null);
  const lastRefreshRef = useRef(0);

  useEffect(() => {
    planRef.current = plan;
  }, [plan]);

  const push = useCallback((message: ChatMessageInput) => {
    setMessages((prev) => [...prev, { ...message, id: nextId() } as ChatMessage]);
  }, []);

  const refreshProjectList = useCallback(() => {
    api
      .listProjects()
      .then((res) => setProjects(res.projects))
      .catch(() => {
        /* server offline; the next action will surface a real error */
      });
  }, []);

  /** Reset every per-project panel to empty — shared by loadProject (before
   *  fetching the next project), newProject, and deleteProject (when the
   *  deleted project was the active one). Callers own projectId/projectIdRef. */
  const clearActiveProjectState = useCallback(() => {
    setProject(null);
    setPlan(null);
    setRenders([]);
    setRenderOverrideUrl(null);
    setLibrary(null);
    setCanvasItems([]);
    setTakes([]);
    setAwaitingApprovalJobId(null);
    setDoneSummary(null);
  }, []);

  /** Empty draft project, made active — shared by the first pre-brief upload
   *  and the "+ New Project" action. */
  const createDraftAndActivate = useCallback(async (): Promise<string> => {
    const res = await api.createDraftProject();
    const pid = res.projectId;
    projectIdRef.current = pid;
    setProjectId(pid);
    push({ kind: "status", stage: "info", text: `Draft project ${pid} created` });
    refreshProjectList();
    return pid;
  }, [push, refreshProjectList]);

  /** Library + canvas + takes for the current project; failures are silent. */
  const refreshPanels = useCallback(async () => {
    const id = projectIdRef.current;
    if (!id) return;
    const guard = <T,>(p: Promise<T>, apply: (value: T) => void) =>
      p.then((value) => {
        if (projectIdRef.current === id) apply(value);
      }).catch(() => {
        /* panel endpoints may 404 mid-rollout; the next refresh catches up */
      });
    await Promise.all([
      guard(api.getLibrary(id), (res) => setLibrary(res)),
      guard(api.getCanvas(id), (res) => setCanvasItems(res.items)),
      guard(api.getTakes(id), (res) => setTakes(res.takes)),
    ]);
  }, []);

  const refreshProject = useCallback(
    async (force = false) => {
      const id = projectIdRef.current;
      if (!id) return;
      const now = Date.now();
      if (!force && now - lastRefreshRef.current < REFRESH_THROTTLE_MS) return;
      lastRefreshRef.current = now;
      try {
        const res = await api.getProject(id);
        if (projectIdRef.current !== id) return; // switched projects meanwhile
        setProject(res.project);
        if (res.plan) setPlan(res.plan);
        setRenders(res.renders ?? []);
      } catch {
        // Mid-job hiccups are fine; the settle-time refresh will catch up.
      }
      void refreshPanels();
    },
    [refreshPanels],
  );

  const startJob = useCallback(
    (jobId: string, label: string) => {
      stopStreamRef.current?.();
      setBusy(true);
      setJobStatus(label);
      stopStreamRef.current = streamJob(jobId, {
        onEvent: (event) => {
          if (event.stage === "plan_ready") {
            setPlan(event.plan);
            push({ kind: "plan", plan: event.plan });
          } else if (event.stage === "awaiting_approval") {
            setAwaitingApprovalJobId(jobId);
            push({ kind: "status", stage: event.stage, text: event.message });
          } else if (event.stage === "render_done") {
            setRenderOverrideUrl(resolveMediaUrl(event.url));
            push({ kind: "status", stage: event.stage, text: eventStatusText(event) });
          } else if (event.stage === "done") {
            setDoneSummary(event.message);
            push({ kind: "status", stage: event.stage, text: event.message });
          } else if (event.stage === "error") {
            push({ kind: "error", text: event.message });
          } else {
            push({ kind: "status", stage: event.stage, text: eventStatusText(event) });
          }
          if (event.stage !== "error") setJobStatus(eventStatusText(event));
          void refreshProject(event.stage === "done" || event.stage === "plan_ready");
        },
        onEnd: (error) => {
          stopStreamRef.current = null;
          setBusy(false);
          setJobStatus(null);
          setAwaitingApprovalJobId(null);
          if (error) push({ kind: "error", text: error });
          void refreshProject(true);
          refreshProjectList();
        },
      });
    },
    [push, refreshProject, refreshProjectList],
  );

  const send = useCallback(
    (raw: string, opts?: { gate?: boolean }) => {
      const text = raw.trim();
      if (!text || busy) return;
      push({ kind: "user", text });

      // No plan yet → this message is the brief: create a project (or direct
      // the existing draft one) and follow the director job.
      if (planRef.current == null) {
        const draftId = projectIdRef.current;
        setBusy(true);
        setJobStatus("Creating project…");
        api
          .createProject({
            brief: text,
            ...(draftId ? { projectId: draftId } : {}),
            ...(opts?.gate ? { gate: true } : {}),
          })
          .then(({ projectId: pid, jobId }) => {
            projectIdRef.current = pid;
            setProjectId(pid);
            push({
              kind: "status",
              stage: "info",
              text: draftId ? `Directing project ${pid}…` : `Project ${pid} created — directing…`,
            });
            startJob(jobId, "Planning…");
          })
          .catch((err: unknown) => {
            setBusy(false);
            setJobStatus(null);
            push({ kind: "error", text: err instanceof Error ? err.message : String(err) });
          });
        return;
      }

      const pid = projectIdRef.current;
      if (!pid) return;
      setBusy(true);
      setJobStatus("Applying edit…");
      api
        .edit(pid, text)
        .then(async (res) => {
          push({ kind: "reply", text: res.reply, applied: res.applied });
          await refreshProject(true);
        })
        .catch((err: unknown) => {
          push({ kind: "error", text: err instanceof Error ? err.message : String(err) });
        })
        .finally(() => {
          setBusy(false);
          setJobStatus(null);
        });
    },
    [busy, push, refreshProject, startJob],
  );

  const approvePlan = useCallback(() => {
    const jobId = awaitingApprovalJobId;
    if (!jobId) return;
    api
      .approveJob(jobId)
      .then(() => {
        setAwaitingApprovalJobId(null);
        push({ kind: "status", stage: "info", text: "Plan approved — generating…" });
        setJobStatus("Generating…");
      })
      .catch((err: unknown) => {
        push({ kind: "error", text: err instanceof Error ? err.message : String(err) });
      });
  }, [awaitingApprovalJobId, push]);

  const upload = useCallback(
    (files: File[], asBrief: boolean) => {
      if (files.length === 0 || uploading) return;
      setUploading(true);
      void (async () => {
        try {
          let pid = projectIdRef.current;
          if (!pid) {
            pid = await createDraftAndActivate();
          }
          push({
            kind: "status",
            stage: "info",
            text: `Uploading ${files.length} ${files.length === 1 ? "file" : "files"}${asBrief ? " as brief" : ""}…`,
          });
          const res = await api.uploadFiles(files, {
            projectId: pid,
            purpose: asBrief ? "brief" : "reference",
          });
          for (const item of res.results) push({ kind: "upload", item });
          await refreshPanels();
        } catch (err) {
          push({ kind: "error", text: err instanceof Error ? err.message : String(err) });
        } finally {
          setUploading(false);
        }
      })();
    },
    [createDraftAndActivate, push, refreshPanels, uploading],
  );

  const retake = useCallback(
    (shotId: string, promptTweak?: string) => {
      const pid = projectIdRef.current;
      if (!pid || busy) return;
      setBusy(true);
      setJobStatus(`Retaking ${shotId}…`);
      push({
        kind: "status",
        stage: "info",
        text: `Retake requested for ${shotId}${promptTweak ? ` — “${promptTweak}”` : ""}`,
      });
      api
        .retakeShot(pid, shotId, promptTweak)
        .then(({ jobId }) => startJob(jobId, `Retaking ${shotId}…`))
        .catch((err: unknown) => {
          setBusy(false);
          setJobStatus(null);
          push({ kind: "error", text: err instanceof Error ? err.message : String(err) });
        });
    },
    [busy, push, startJob],
  );

  const selectTake = useCallback(
    (takeId: string) => {
      const pid = projectIdRef.current;
      if (!pid || busy) return;
      api
        .selectTake(pid, takeId)
        .then(async ({ summary }) => {
          push({ kind: "status", stage: "info", text: summary });
          await refreshProject(true);
        })
        .catch((err: unknown) => {
          push({ kind: "error", text: err instanceof Error ? err.message : String(err) });
        });
    },
    [busy, push, refreshProject],
  );

  const moveCanvasItem = useCallback(
    async (itemId: string, pos: { x?: number; y?: number; w?: number; h?: number; z?: number }) => {
      const pid = projectIdRef.current;
      if (!pid) return;
      const { item } = await api.moveCanvasItem(pid, itemId, pos);
      setCanvasItems((prev) => prev.map((it) => (it.id === item.id ? item : it)));
    },
    [],
  );

  const addCanvasNote = useCallback(
    async (text: string, x: number, y: number) => {
      const pid = projectIdRef.current;
      if (!pid) {
        push({ kind: "error", text: "Create or open a project before adding notes." });
        return;
      }
      try {
        const { item } = await api.addCanvasNote(pid, { text, x, y });
        setCanvasItems((prev) => [...prev, item]);
      } catch (err) {
        push({ kind: "error", text: err instanceof Error ? err.message : String(err) });
      }
    },
    [push],
  );

  const undoRedo = useCallback(
    (which: "undo" | "redo") => {
      const pid = projectIdRef.current;
      if (!pid || busy) return;
      api[which](pid)
        .then(async ({ summary }) => {
          push({ kind: "status", stage: "info", text: `${which === "undo" ? "Undid" : "Redid"}: ${summary}` });
          await refreshProject(true);
        })
        .catch((err: unknown) => {
          push({ kind: "error", text: err instanceof Error ? err.message : String(err) });
        });
    },
    [busy, push, refreshProject],
  );

  const undo = useCallback(() => undoRedo("undo"), [undoRedo]);
  const redo = useCallback(() => undoRedo("redo"), [undoRedo]);

  const render = useCallback(
    (draft: boolean) => {
      const pid = projectIdRef.current;
      if (!pid || busy) return;
      setBusy(true);
      setJobStatus(draft ? "Starting draft render…" : "Starting final render…");
      api
        .render(pid, draft)
        .then(({ jobId }) => startJob(jobId, draft ? "Rendering draft…" : "Rendering final…"))
        .catch((err: unknown) => {
          setBusy(false);
          setJobStatus(null);
          push({ kind: "error", text: err instanceof Error ? err.message : String(err) });
        });
    },
    [busy, push, startJob],
  );

  const loadProject = useCallback(
    (id: string) => {
      if (busy || !id || id === projectIdRef.current) return;
      stopStreamRef.current?.();
      stopStreamRef.current = null;
      projectIdRef.current = id;
      setProjectId(id);
      clearActiveProjectState();
      api
        .getProject(id)
        .then((res) => {
          if (projectIdRef.current !== id) return;
          setProject(res.project);
          setPlan(res.plan ?? null);
          setRenders(res.renders ?? []);
          push({ kind: "status", stage: "info", text: `Loaded project “${res.project.metadata.name}”` });
        })
        .catch((err: unknown) => {
          push({ kind: "error", text: err instanceof Error ? err.message : String(err) });
        });
      void refreshPanels();
    },
    [busy, clearActiveProjectState, push, refreshPanels],
  );

  const newProject = useCallback(() => {
    if (busy) return;
    stopStreamRef.current?.();
    stopStreamRef.current = null;
    clearActiveProjectState();
    void createDraftAndActivate().catch((err: unknown) => {
      push({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    });
  }, [busy, clearActiveProjectState, createDraftAndActivate, push]);

  const renameProject = useCallback(
    async (id: string, name: string): Promise<boolean> => {
      try {
        await api.renameProject(id, name);
        refreshProjectList();
        return true;
      } catch (err) {
        push({ kind: "error", text: err instanceof Error ? err.message : String(err) });
        return false;
      }
    },
    [push, refreshProjectList],
  );

  const duplicateProject = useCallback(
    async (id: string): Promise<string | null> => {
      try {
        const { projectId: newId } = await api.duplicateProject(id);
        refreshProjectList();
        loadProject(newId);
        return newId;
      } catch (err) {
        push({ kind: "error", text: err instanceof Error ? err.message : String(err) });
        return null;
      }
    },
    [loadProject, push, refreshProjectList],
  );

  const deleteProject = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        await api.deleteProject(id);
        refreshProjectList();
        if (projectIdRef.current === id) {
          stopStreamRef.current?.();
          stopStreamRef.current = null;
          projectIdRef.current = null;
          setProjectId(null);
          clearActiveProjectState();
        }
        return true;
      } catch (err) {
        push({ kind: "error", text: err instanceof Error ? err.message : String(err) });
        return false;
      }
    },
    [clearActiveProjectState, push, refreshProjectList],
  );

  const loadSettings = useCallback(() => {
    setSettingsLoading(true);
    setSettingsError(null);
    api
      .getSettings()
      .then((res) => setSettings(res))
      .catch((err: unknown) => setSettingsError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSettingsLoading(false));
  }, []);

  const saveSettings = useCallback(async (patch: UpdateSettingsRequest): Promise<boolean> => {
    if (Object.keys(patch).length === 0) return true;
    setSettingsSaving(true);
    setSettingsError(null);
    try {
      const res = await api.updateSettings(patch);
      setSettings(res);
      return true;
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSettingsSaving(false);
    }
  }, []);

  useEffect(() => {
    refreshProjectList();
    return () => stopStreamRef.current?.();
  }, [refreshProjectList]);

  const latestRenderUrl = useMemo(() => {
    if (renderOverrideUrl) return renderOverrideUrl;
    if (renders.length === 0) return null;
    const newest = [...renders].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!;
    return resolveMediaUrl(newest.url);
  }, [renderOverrideUrl, renders]);

  return {
    messages,
    projects,
    projectId,
    project,
    plan,
    renders,
    latestRenderUrl,
    library,
    canvasItems,
    takes,
    busy,
    uploading,
    jobStatus,
    awaitingApprovalJobId,
    doneSummary,
    send,
    approvePlan,
    upload,
    retake,
    selectTake,
    moveCanvasItem,
    addCanvasNote,
    undo,
    redo,
    render,
    loadProject,
    refreshProjectList,
    newProject,
    renameProject,
    duplicateProject,
    deleteProject,
    settings,
    settingsLoading,
    settingsSaving,
    settingsError,
    loadSettings,
    saveSettings,
  };
}
