import { useState, useEffect, useCallback, useRef } from "react";
import { useOptimizerStore } from "@/lib/store";
import { createNeuronWriterService } from "@/lib/sota/NeuronWriterService";
import {
  Key, Globe, User, Building, Image, UserCircle,
  Sparkles, MapPin, Check, AlertCircle, ExternalLink, Database,
  Settings, Loader2, FolderOpen, RefreshCw, XCircle, Bot, Zap,
  Save, Download, Upload, RotateCcw, Trash2
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getSupabaseConfig, saveSupabaseConfig, clearSupabaseConfig, validateSupabaseConfig } from "@/lib/supabaseClient";
import { toast } from "sonner";
import { ensureTableExists, getLastDbCheckError } from "@/lib/api/contentPersistence";
import { AuthorProfilesPanel } from "@/components/optimizer/AuthorProfilesPanel";

const OPENROUTER_MODELS = [
  { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
  { id: 'anthropic/claude-3-opus', name: 'Claude 3 Opus' },
  { id: 'openai/gpt-4o', name: 'GPT-4o' },
  { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' },
  { id: 'google/gemini-pro-1.5', name: 'Gemini Pro 1.5' },
  { id: 'meta-llama/llama-3.1-405b-instruct', name: 'Llama 3.1 405B' },
  { id: 'meta-llama/llama-3.1-70b-instruct', name: 'Llama 3.1 70B' },
  { id: 'mistralai/mixtral-8x22b-instruct', name: 'Mixtral 8x22B' },
  { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat' },
  { id: 'cohere/command-r-plus', name: 'Command R+' },
];

const GROQ_MODELS = [
  { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile' },
  { id: 'llama-3.1-70b-instant', name: 'Llama 3.1 70B Instant' },
  { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B Instant' },
  { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B' },
  { id: 'gemma2-9b-it', name: 'Gemma 2 9B' },
  { id: 'llama3-groq-70b-8192-tool-use-preview', name: 'Llama 3 70B Tool Use' },
];

const UNSAFE_LONGFORM_OPENROUTER_PATTERNS = [/:free$/i, /deepseek\/deepseek-v4-flash/i, /deepseek.*flash/i, /owl-alpha/i, /tencent\/hy3/i];
const isUnsafeLongformOpenRouterModel = (modelId: string) =>
  UNSAFE_LONGFORM_OPENROUTER_PATTERNS.some(pattern => pattern.test(modelId));

export function SetupConfig() {
  const {
    config,
    setConfig,
    neuronWriterProjects,
    setNeuronWriterProjects,
    neuronWriterLoading,
    setNeuronWriterLoading,
    neuronWriterError,
    setNeuronWriterError
  } = useOptimizerStore();

  const [verifyingWp, setVerifyingWp] = useState(false);
  const [wpVerified, setWpVerified] = useState<boolean | null>(null);
  const [customOpenRouterModel, setCustomOpenRouterModel] = useState('');
  const [customGroqModel, setCustomGroqModel] = useState('');
  const [showCustomOpenRouter, setShowCustomOpenRouter] = useState(false);
  const [showCustomGroq, setShowCustomGroq] = useState(false);
  const [nwFetchAttempted, setNwFetchAttempted] = useState(false);

  // Fallback model add form
  const [fbProvider, setFbProvider] = useState<string>('openrouter');
  const [fbModelId, setFbModelId] = useState<string>('');
  const [fbCustomModelId, setFbCustomModelId] = useState<string>('');
  const [fbShowCustom, setFbShowCustom] = useState(false);

  const [sbUrl, setSbUrl] = useState(config.supabaseUrl || '');
  const [sbAnonKey, setSbAnonKey] = useState(config.supabaseAnonKey || '');
  const sbStatus = validateSupabaseConfig(sbUrl.trim(), sbAnonKey.trim());

  const configRef = useRef(config);
  configRef.current = config;

  const fetchNeuronWriterProjects = useCallback(async (apiKey: string) => {
    if (!apiKey || apiKey.trim().length < 10) {
      setNeuronWriterProjects([]);
      setNeuronWriterError(null);
      setNwFetchAttempted(false);
      return;
    }

    setNeuronWriterLoading(true);
    setNeuronWriterError(null);
    setNwFetchAttempted(true);

    try {
      const service = createNeuronWriterService({
        neuronWriterApiKey: apiKey,
        supabaseUrl: sbUrl.trim() || configRef.current.supabaseUrl,
        supabaseAnonKey: sbAnonKey.trim() || configRef.current.supabaseAnonKey
      });
      const result = await service.listProjects();

      if (result.success && result.projects) {
        setNeuronWriterProjects(result.projects);
        setNeuronWriterError(null);

        if (result.projects.length > 0 && !configRef.current.neuronWriterProjectId) {
          setConfig({
            neuronWriterProjectId: result.projects[0].id,
            neuronWriterProjectName: result.projects[0].name
          });
        }
      } else {
        const errorMsg = result.error || 'Failed to fetch projects';
        setNeuronWriterError(errorMsg);
        setNeuronWriterProjects([]);
      }
    } catch (error) {
      console.error('NeuronWriter fetch error:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      setNeuronWriterError(`Connection failed: ${message}`);
      setNeuronWriterProjects([]);
    } finally {
      setNeuronWriterLoading(false);
    }
  }, [setNeuronWriterProjects, setNeuronWriterLoading, setNeuronWriterError, setConfig, sbUrl, sbAnonKey]);

  useEffect(() => {
    if (config.enableNeuronWriter && config.neuronWriterApiKey && config.neuronWriterApiKey.trim().length >= 10) {
      const debounceTimer = setTimeout(() => {
        fetchNeuronWriterProjects(config.neuronWriterApiKey);
      }, 800);
      return () => clearTimeout(debounceTimer);
    }
  }, [config.enableNeuronWriter, config.neuronWriterApiKey, fetchNeuronWriterProjects]);

  const handleSaveSupabase = () => {
    const url = sbUrl.trim();
    const key = sbAnonKey.trim();
    const status = validateSupabaseConfig(url, key);
    if (!status.configured) return;
    setConfig({ supabaseUrl: url, supabaseAnonKey: key });
    saveSupabaseConfig(url, key);
  };

  const handleTestSupabase = async () => {
    try {
      const ok = await ensureTableExists();
      if (ok) {
        toast.success('Supabase connected ✓ History sync is online.');
        return;
      }
      const detail = getLastDbCheckError();
      if (!detail) {
        toast.error('Supabase not configured (missing URL or anon key).');
        return;
      }
      if (detail.kind === 'missing_table') {
        toast.error('Connected, but table generated_blog_posts is missing. Create it in Supabase SQL Editor.');
      } else if (detail.kind === 'rls') {
        toast.error('Connected, but RLS is blocking access. Update your RLS policy.');
      } else {
        toast.error(detail.message);
      }
    } catch (e: any) {
      toast.error(e?.message || 'Supabase connection test failed');
    }
  };

  const handleClearSupabase = () => {
    setSbUrl('');
    setSbAnonKey('');
    setConfig({ supabaseUrl: '', supabaseAnonKey: '' });
    clearSupabaseConfig();
  };

  const handleReloadAfterSupabase = () => {
    window.location.reload();
  };

  const handleVerifyWordPress = async () => {
    if (!config.wpUrl || !config.wpUsername || !config.wpAppPassword) return;
    setVerifyingWp(true);
    setWpVerified(null);
    try {
      // Normalize URL
      let baseUrl = config.wpUrl.trim().replace(/\/+$/, '');
      if (!baseUrl.startsWith('http')) baseUrl = `https://${baseUrl}`;

      // Validate URL format
      try {
        const parsed = new URL(baseUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error('URL must use HTTP or HTTPS');
        }
      } catch {
        toast.error('❌ Invalid WordPress URL', {
          description: 'Please enter a valid URL (e.g. https://yoursite.com)',
        });
        setWpVerified(false);
        return;
      }

      const authBase64 = btoa(`${config.wpUsername}:${config.wpAppPassword}`);
      const authHeaders = {
        Authorization: `Basic ${authBase64}`,
        Accept: 'application/json',
      };

      // Step 1: Check REST API root reachable (no auth required, validates WP + REST API)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      let rootRes: Response;
      try {
        rootRes = await fetch(`${baseUrl}/wp-json/`, {
          method: 'GET',
          signal: controller.signal,
        });
      } catch (e) {
        clearTimeout(timeoutId);
        const msg = e instanceof Error ? e.message : String(e);
        const isTimeout = msg.includes('abort');
        const isCors = msg.toLowerCase().includes('failed to fetch') || msg.toLowerCase().includes('cors');
        toast.error('❌ Cannot reach WordPress', {
          description: isTimeout
            ? 'Request timed out after 15s. Check the URL and that the site is online.'
            : isCors
              ? 'Network/CORS error. The site may be blocking browser requests, but publishing via the server proxy may still work.'
              : `Could not reach ${baseUrl}: ${msg}`,
        });
        setWpVerified(false);
        return;
      }
      clearTimeout(timeoutId);

      if (!rootRes.ok) {
        toast.error('❌ WordPress REST API not found', {
          description: `Got ${rootRes.status} from ${baseUrl}/wp-json/. Ensure permalinks are enabled (Settings → Permalinks → Save).`,
        });
        setWpVerified(false);
        return;
      }

      // Step 2: Authenticated check — GET /users/me requires valid credentials
      const ctrl2 = new AbortController();
      const t2 = setTimeout(() => ctrl2.abort(), 15000);
      let meRes: Response;
      try {
        meRes = await fetch(`${baseUrl}/wp-json/wp/v2/users/me?context=edit`, {
          method: 'GET',
          headers: authHeaders,
          signal: ctrl2.signal,
        });
      } catch (e) {
        clearTimeout(t2);
        const msg = e instanceof Error ? e.message : String(e);
        toast.error('⚠️ Auth check blocked by browser', {
          description: `Could not verify credentials directly: ${msg}. Publishing may still work via the server proxy.`,
        });
        setWpVerified(false);
        return;
      }
      clearTimeout(t2);

      if (meRes.status === 401) {
        toast.error('❌ Authentication failed', {
          description: 'Username or Application Password is incorrect. Generate a new App Password under Users → Profile → Application Passwords.',
        });
        setWpVerified(false);
        return;
      }
      if (meRes.status === 403) {
        toast.error('❌ Permission denied', {
          description: 'Credentials are valid but the user lacks edit/publish capabilities. Use an Admin or Editor account.',
        });
        setWpVerified(false);
        return;
      }
      if (!meRes.ok) {
        toast.error('❌ Verification failed', {
          description: `WordPress returned ${meRes.status}. Check your URL and credentials.`,
        });
        setWpVerified(false);
        return;
      }

      const me = await meRes.json().catch(() => null) as { name?: string; slug?: string; capabilities?: Record<string, boolean> } | null;
      const canPublish = me?.capabilities
        ? !!(me.capabilities.publish_posts || me.capabilities.edit_posts || me.capabilities.administrator)
        : true;

      if (!canPublish) {
        toast.error('⚠️ User cannot publish posts', {
          description: `Logged in as "${me?.name || me?.slug || config.wpUsername}" but the role lacks publish_posts capability.`,
        });
        setWpVerified(false);
        return;
      }

      toast.success('✅ WordPress verified', {
        description: `Connected as ${me?.name || me?.slug || config.wpUsername}. Ready to publish.`,
      });
      setWpVerified(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      toast.error('❌ Verification error', { description: msg });
      setWpVerified(false);
    } finally {
      setVerifyingWp(false);
    }
  };

  const handleProjectSelect = (projectId: string) => {
    const project = neuronWriterProjects.find(p => p.id === projectId);
    setConfig({
      neuronWriterProjectId: projectId,
      neuronWriterProjectName: project?.name || ''
    });
  };

  const handleOpenRouterModelChange = (value: string) => {
    if (value === 'custom') {
      setShowCustomOpenRouter(true);
    } else {
      setShowCustomOpenRouter(false);
      setConfig({ openrouterModelId: value });
    }
  };

  const handleGroqModelChange = (value: string) => {
    if (value === 'custom') {
      setShowCustomGroq(true);
    } else {
      setShowCustomGroq(false);
      setConfig({ groqModelId: value });
    }
  };

  const handleCustomOpenRouterSubmit = () => {
    if (customOpenRouterModel.trim()) {
      setConfig({ openrouterModelId: customOpenRouterModel.trim() });
    }
  };

  const handleCustomGroqSubmit = () => {
    if (customGroqModel.trim()) {
      setConfig({ groqModelId: customGroqModel.trim() });
    }
  };

  // ─── Save / Load Snapshot Configuration (Multi-Profile) ─────────────────────
  const SNAPSHOTS_KEY = 'wp-optimizer-config-snapshots';
  const LEGACY_SNAPSHOT_KEY = 'wp-optimizer-config-snapshot';
  const ACTIVE_SNAPSHOT_KEY = 'wp-optimizer-active-snapshot';
  const fileInputRef = useRef<HTMLInputElement>(null);

  type SnapshotRecord = { name: string; savedAt: string; config: AppConfig };
  type SnapshotMap = Record<string, SnapshotRecord>;
  // We need AppConfig type — fall back to typeof config
  // (kept loose to avoid extra imports)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AppConfig = any;

  const loadSnapshotsFromStorage = (): SnapshotMap => {
    try {
      const raw = localStorage.getItem(SNAPSHOTS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return parsed as SnapshotMap;
      }
      // Migrate legacy single snapshot
      const legacy = localStorage.getItem(LEGACY_SNAPSHOT_KEY);
      if (legacy) {
        const p = JSON.parse(legacy);
        if (p?.config) {
          const migrated: SnapshotMap = {
            Default: { name: 'Default', savedAt: p.savedAt ?? new Date().toISOString(), config: p.config },
          };
          localStorage.setItem(SNAPSHOTS_KEY, JSON.stringify(migrated));
          return migrated;
        }
      }
    } catch { /* ignore */ }
    return {};
  };

  const [snapshots, setSnapshots] = useState<SnapshotMap>(() => loadSnapshotsFromStorage());
  const [activeSnapshot, setActiveSnapshot] = useState<string>(() => {
    try { return localStorage.getItem(ACTIVE_SNAPSHOT_KEY) ?? ''; } catch { return ''; }
  });
  const [renameMode, setRenameMode] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  // Inline "save as" name input (replaces window.prompt which is blocked in sandboxed iframes)
  const [saveAsMode, setSaveAsMode] = useState(false);
  const [saveAsValue, setSaveAsValue] = useState('');
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const persistSnapshots = (map: SnapshotMap) => {
    localStorage.setItem(SNAPSHOTS_KEY, JSON.stringify(map));
    setSnapshots({ ...map });
  };
  const setActive = (name: string) => {
    setActiveSnapshot(name);
    try { localStorage.setItem(ACTIVE_SNAPSHOT_KEY, name); } catch { /* ignore */ }
  };

  const snapshotNames = Object.keys(snapshots).sort((a, b) => a.localeCompare(b));
  const hasSnapshot = snapshotNames.length > 0;
  const currentRecord = activeSnapshot ? snapshots[activeSnapshot] : undefined;
  const snapshotMeta = currentRecord ? new Date(currentRecord.savedAt).toLocaleString() : null;

  const handleSaveSnapshot = () => {
    // Quick save: overwrite active profile. If none, open inline name input (window.prompt is blocked in sandboxed iframes).
    if (!activeSnapshot) {
      setSaveAsValue(`Profile ${snapshotNames.length + 1}`);
      setSaveAsMode(true);
      return;
    }
    try {
      const map = { ...snapshots };
      map[activeSnapshot] = { name: activeSnapshot, savedAt: new Date().toISOString(), config };
      persistSnapshots(map);
      toast.success(`Saved "${activeSnapshot}"`, { description: 'Configuration stored locally.' });
    } catch (err) {
      toast.error('Failed to save snapshot', { description: String((err as Error)?.message ?? err) });
    }
  };

  const handleSaveAsSnapshot = () => {
    setSaveAsValue(activeSnapshot ? `${activeSnapshot} (copy)` : `Profile ${snapshotNames.length + 1}`);
    setSaveAsMode(true);
  };

  const commitSaveAs = (overwrite = false) => {
    const trimmed = saveAsValue.trim();
    if (!trimmed) { toast.error('Please enter a profile name'); return; }
    if (snapshots[trimmed] && !overwrite) {
      // Ask for overwrite via state, not window.confirm
      const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm(`A profile named "${trimmed}" already exists. Overwrite?`)
        : true;
      if (!ok) return;
    }
    try {
      const map = { ...snapshots };
      map[trimmed] = { name: trimmed, savedAt: new Date().toISOString(), config };
      persistSnapshots(map);
      setActive(trimmed);
      setSaveAsMode(false);
      setSaveAsValue('');
      toast.success(`Saved "${trimmed}"`, { description: 'You can now load it any time.' });
    } catch (err) {
      toast.error('Failed to save', { description: String((err as Error)?.message ?? err) });
    }
  };

  const handleRenameSnapshot = () => {
    if (!activeSnapshot) { toast.error('Select a profile to rename'); return; }
    setRenameValue(activeSnapshot);
    setRenameMode(true);
  };

  const commitRename = () => {
    const newName = renameValue.trim();
    if (!newName) { setRenameMode(false); return; }
    if (newName === activeSnapshot) { setRenameMode(false); return; }
    if (snapshots[newName]) {
      toast.error(`A profile named "${newName}" already exists`);
      return;
    }
    try {
      const map = { ...snapshots };
      const rec = map[activeSnapshot];
      if (!rec) { setRenameMode(false); return; }
      delete map[activeSnapshot];
      map[newName] = { ...rec, name: newName };
      persistSnapshots(map);
      setActive(newName);
      setRenameMode(false);
      toast.success(`Renamed to "${newName}"`);
    } catch (err) {
      toast.error('Rename failed', { description: String((err as Error)?.message ?? err) });
    }
  };

  const handleLoadSnapshot = (nameArg?: string) => {
    const name = nameArg ?? activeSnapshot;
    if (!name) { toast.error('Select a profile to load'); return; }
    const rec = snapshots[name];
    if (!rec?.config) { toast.error('Snapshot is corrupted'); return; }
    try {
      setConfig(rec.config);
      if (rec.config.supabaseUrl) setSbUrl(rec.config.supabaseUrl);
      if (rec.config.supabaseAnonKey) setSbAnonKey(rec.config.supabaseAnonKey);
      setActive(name);
      toast.success(`Loaded "${name}"`, { description: `Saved ${new Date(rec.savedAt).toLocaleString()}` });
    } catch (err) {
      toast.error('Failed to load snapshot', { description: String((err as Error)?.message ?? err) });
    }
  };

  const handleExportConfig = () => {
    try {
      const payload = { version: 1, exportedAt: new Date().toISOString(), config };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `wp-optimizer-config-${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success('Configuration exported', { description: 'Saved as JSON in your downloads.' });
    } catch (err) {
      toast.error('Export failed', { description: String((err as Error)?.message ?? err) });
    }
  };

  const handleImportConfig = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(String(ev.target?.result ?? ''));
        const cfg = parsed?.config ?? parsed;
        if (!cfg || typeof cfg !== 'object') throw new Error('Invalid file');
        setConfig(cfg);
        if (cfg.supabaseUrl) setSbUrl(cfg.supabaseUrl);
        if (cfg.supabaseAnonKey) setSbAnonKey(cfg.supabaseAnonKey);
        toast.success('Configuration imported', { description: 'All fields populated from the file.' });
      } catch {
        toast.error('Import failed', { description: 'Make sure the file is a valid JSON config export.' });
      } finally {
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    };
    reader.onerror = () => toast.error('Could not read file');
    reader.readAsText(file);
  };

  const handleDeleteSnapshot = (nameArg?: string) => {
    const name = nameArg ?? activeSnapshot;
    if (!name) return;
    // Use inline confirm via state — window.confirm may be blocked in sandboxed iframes
    setPendingDelete(name);
  };

  const confirmDelete = () => {
    const name = pendingDelete;
    if (!name) return;
    try {
      const map = { ...snapshots };
      delete map[name];
      persistSnapshots(map);
      if (activeSnapshot === name) setActive('');
      toast.success(`Deleted "${name}"`);
    } catch {
      toast.error('Failed to delete snapshot');
    } finally {
      setPendingDelete(null);
    }
  };

  // Setup KPI signals — drives the hero status strip
  const aiOk = !!(config.openrouterApiKey || config.groqApiKey || config.geminiApiKey || config.anthropicApiKey || config.openaiApiKey);
  const wpOk = !!(config.wpUrl && config.wpUsername && config.wpAppPassword);
  const nwOk = !!(config.enableNeuronWriter && config.neuronWriterApiKey && (neuronWriterProjects?.length ?? 0) > 0);
  const sbOk = !!sbStatus.configured;
  const readyCount = [aiOk, wpOk, nwOk, sbOk].filter(Boolean).length;

  return (
    <div className="space-y-5 md:space-y-7">
      {/* ── Premium Hero Header ── */}
      <div className="relative overflow-hidden rounded-2xl md:rounded-3xl border border-white/10 bg-gradient-to-br from-emerald-950/40 via-background/60 to-background/30 p-5 md:p-8 shadow-2xl">
        <div className="absolute -top-24 -right-24 w-72 h-72 rounded-full bg-primary/20 blur-3xl pointer-events-none" />
        <div className="absolute -bottom-32 -left-20 w-72 h-72 rounded-full bg-emerald-500/10 blur-3xl pointer-events-none" />
        <div className="relative flex flex-col md:flex-row md:items-end md:justify-between gap-5">
          <div className="min-w-0">
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-primary/15 border border-primary/30 text-[10px] font-bold uppercase tracking-[0.18em] text-primary mb-3">
              <Sparkles className="w-3 h-3" /> Step 1 · Foundation
            </div>
            <h1 className="text-2xl md:text-4xl font-black text-foreground tracking-tight flex items-center gap-3">
              <span className="hidden md:inline-flex w-11 h-11 items-center justify-center rounded-xl bg-gradient-to-br from-primary/30 to-emerald-700/20 border border-primary/40 shadow-lg shadow-primary/20">
                <Settings className="w-5 h-5 text-primary" />
              </span>
              <span className="bg-gradient-to-r from-foreground via-foreground to-primary bg-clip-text text-transparent">
                Setup &amp; Configuration
              </span>
            </h1>
            <p className="text-muted-foreground mt-2 text-sm md:text-base max-w-xl">
              Wire up AI providers, WordPress, NeuronWriter, and Supabase — then let the engine do the rest.
            </p>
          </div>

          <div className="grid grid-cols-4 gap-2 md:gap-3 md:flex md:items-stretch md:gap-2 shrink-0">
            <SetupStat label="AI" ok={aiOk} />
            <SetupStat label="WP" ok={wpOk} />
            <SetupStat label="Neuron" ok={nwOk} optional />
            <SetupStat label="DB" ok={sbOk} optional />
          </div>
        </div>

        {/* progress strip */}
        <div className="relative mt-5 md:mt-6 h-1.5 rounded-full bg-white/5 overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 bg-gradient-to-r from-primary via-emerald-400 to-teal-300 shadow-[0_0_12px_hsla(160,84%,39%,0.6)] transition-all duration-700"
            style={{ width: `${(readyCount / 4) * 100}%` }}
          />
        </div>
        <div className="relative mt-2 text-[11px] md:text-xs text-muted-foreground/80 font-semibold tabular-nums">
          {readyCount}/4 services ready
        </div>
      </div>

      {/* Author Profiles + Brand Voice (M2 — E-E-A-T) — optional */}
      <section className="glass-card rounded-2xl p-6 sm:p-8 border border-emerald-500/20 space-y-4">
        <div className="flex items-start sm:items-center justify-between gap-4 flex-col sm:flex-row">
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-foreground">Author Library & Brand Voice</h2>
            <p className="text-xs text-muted-foreground mt-1">
              Optional. Adds Person + Article JSON-LD and injects voice rules into the prompt. Hide this if you don't use bylines or fingerprinting.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm shrink-0 cursor-pointer">
            <input
              type="checkbox"
              checked={useOptimizerStore(s => s.eeatPanelEnabled)}
              onChange={(e) => useOptimizerStore.getState().setEeatPanelEnabled(e.target.checked)}
              className="w-4 h-4 accent-emerald-500"
            />
            <span className="text-muted-foreground">{useOptimizerStore(s => s.eeatPanelEnabled) ? 'Enabled' : 'Hidden'}</span>
          </label>
        </div>
        {useOptimizerStore(s => s.eeatPanelEnabled) && <AuthorProfilesPanel />}
      </section>

      {/* Save / Load Configuration */}
      <section className="glass-card rounded-2xl p-6 sm:p-8 border border-primary/20 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/20 flex items-center justify-center shrink-0">
              <Save className="w-5 h-5 text-primary" />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-bold text-foreground">Configuration Snapshots</h2>
              <p className="text-xs text-muted-foreground mt-1">
                {hasSnapshot && currentRecord
                  ? <>Active: <span className="text-primary font-semibold">{activeSnapshot || '(none selected)'}</span> · Last saved <span className="text-foreground/80">{snapshotMeta}</span></>
                  : 'No profiles saved yet. Click "Save As" to create your first profile.'}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Profile selector */}
            {hasSnapshot && !renameMode && (
              <select
                value={activeSnapshot}
                onChange={(e) => {
                  const name = e.target.value;
                  setActive(name);
                  if (name) handleLoadSnapshot(name);
                }}
                className="px-3 py-2 rounded-lg bg-background border border-border text-foreground text-sm font-medium focus:outline-none focus:ring-2 focus:ring-primary/40 min-w-[160px]"
              >
                <option value="">Select profile…</option>
                {snapshotNames.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            )}

            {renameMode && (
              <div className="flex items-center gap-1">
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename();
                    if (e.key === 'Escape') setRenameMode(false);
                  }}
                  placeholder="New profile name"
                  className="px-3 py-2 rounded-lg bg-background border border-primary/40 text-foreground text-sm font-medium focus:outline-none focus:ring-2 focus:ring-primary/40 min-w-[180px]"
                />
                <button
                  onClick={commitRename}
                  className="px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90"
                >
                  <Check className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setRenameMode(false)}
                  className="px-3 py-2 rounded-lg border border-border text-foreground text-sm hover:bg-accent"
                >
                  <XCircle className="w-4 h-4" />
                </button>
              </div>
            )}

            <button
              onClick={handleSaveSnapshot}
              title={activeSnapshot ? `Overwrite "${activeSnapshot}"` : 'Save current configuration'}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-all font-semibold text-sm shadow-md hover:shadow-lg"
            >
              <Save className="w-4 h-4" />
              {activeSnapshot ? 'Save' : 'Save'}
            </button>
            <button
              onClick={handleSaveAsSnapshot}
              title="Save as a new named profile"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20 transition-all font-semibold text-sm"
            >
              <Save className="w-4 h-4" />
              Save As…
            </button>
            <button
              onClick={() => handleLoadSnapshot()}
              disabled={!activeSnapshot}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-all font-semibold text-sm disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <RotateCcw className="w-4 h-4" />
              Load
            </button>
            <button
              onClick={handleRenameSnapshot}
              disabled={!activeSnapshot || renameMode}
              title="Rename active profile"
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-foreground hover:bg-accent transition-all text-sm disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Settings className="w-4 h-4" />
              Rename
            </button>
            <button
              onClick={handleExportConfig}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-border text-foreground hover:bg-accent transition-all font-medium text-sm"
            >
              <Download className="w-4 h-4" />
              Export
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-border text-foreground hover:bg-accent transition-all font-medium text-sm"
            >
              <Upload className="w-4 h-4" />
              Import
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              onChange={handleImportConfig}
              className="hidden"
            />
            {activeSnapshot && (
              <button
                onClick={() => handleDeleteSnapshot()}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-destructive/30 text-destructive hover:bg-destructive/10 transition-all text-sm"
                title={`Delete "${activeSnapshot}"`}
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Saved profiles list */}
        {snapshotNames.length > 0 && (
          <div className="pt-4 border-t border-border/50">
            <p className="text-xs uppercase tracking-wide text-muted-foreground font-semibold mb-2">Saved profiles ({snapshotNames.length})</p>
            <div className="flex flex-wrap gap-2">
              {snapshotNames.map((n) => {
                const isActive = n === activeSnapshot;
                return (
                  <div
                    key={n}
                    className={cn(
                      'group flex items-center gap-1 rounded-lg border text-sm transition-all',
                      isActive
                        ? 'border-primary/50 bg-primary/10'
                        : 'border-border bg-background hover:border-primary/30'
                    )}
                  >
                    <button
                      onClick={() => handleLoadSnapshot(n)}
                      className={cn(
                        'px-3 py-1.5 font-medium',
                        isActive ? 'text-primary' : 'text-foreground'
                      )}
                      title={`Load "${n}" (saved ${new Date(snapshots[n].savedAt).toLocaleString()})`}
                    >
                      {n}
                    </button>
                    <button
                      onClick={() => handleDeleteSnapshot(n)}
                      className="px-2 py-1.5 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                      title={`Delete "${n}"`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Inline Save-As input (replaces window.prompt which is blocked in sandboxed iframes) */}
        {saveAsMode && (
          <div className="pt-4 border-t border-border/50">
            <p className="text-xs uppercase tracking-wide text-primary font-semibold mb-2">Name your configuration profile</p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                autoFocus
                value={saveAsValue}
                onChange={(e) => setSaveAsValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitSaveAs();
                  if (e.key === 'Escape') { setSaveAsMode(false); setSaveAsValue(''); }
                }}
                placeholder="e.g. Client A — Health Site"
                className="flex-1 min-w-[240px] px-3 py-2 rounded-lg bg-background border border-primary/40 text-foreground text-sm font-medium focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
              <button
                onClick={() => commitSaveAs()}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 font-semibold text-sm"
              >
                <Check className="w-4 h-4" /> Save profile
              </button>
              <button
                onClick={() => { setSaveAsMode(false); setSaveAsValue(''); }}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-foreground hover:bg-accent text-sm"
              >
                <XCircle className="w-4 h-4" /> Cancel
              </button>
            </div>
            {saveAsValue.trim() && snapshots[saveAsValue.trim()] && (
              <p className="text-xs text-amber-500 mt-2">⚠ A profile named "{saveAsValue.trim()}" already exists — saving will overwrite it.</p>
            )}
          </div>
        )}

        {/* Inline delete confirmation */}
        {pendingDelete && (
          <div className="pt-4 border-t border-border/50">
            <div className="flex flex-wrap items-center gap-3 p-3 rounded-lg bg-destructive/10 border border-destructive/30">
              <p className="text-sm text-foreground flex-1 min-w-[200px]">
                Delete profile <span className="font-semibold text-destructive">"{pendingDelete}"</span>? This cannot be undone.
              </p>
              <button
                onClick={confirmDelete}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-destructive text-destructive-foreground hover:bg-destructive/90 font-semibold text-sm"
              >
                <Trash2 className="w-4 h-4" /> Delete
              </button>
              <button
                onClick={() => setPendingDelete(null)}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-foreground hover:bg-accent text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>


      {/* API Keys Section */}
      <section className="glass-card rounded-2xl p-8 hover:shadow-lg transition-all duration-300 group">
        <h2 className="text-xl font-bold text-white mb-6 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/20 flex items-center justify-center group-hover:scale-110 transition-transform duration-300">
            <Key className="w-5 h-5 text-primary" />
          </div>
          API Keys
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <InputField label="Google Gemini API Key" value={config.geminiApiKey} onChange={(v) => setConfig({ geminiApiKey: v })} type="password" placeholder="AIza..." icon={<Key className="w-4 h-4" />} />
          <InputField label="Serper API Key (Required for SOTA Research)" value={config.serperApiKey} onChange={(v) => setConfig({ serperApiKey: v })} type="password" placeholder="Enter Serper key..." required icon={<Globe className="w-4 h-4" />} />
          <InputField label="OpenAI API Key" value={config.openaiApiKey} onChange={(v) => setConfig({ openaiApiKey: v })} type="password" placeholder="sk-..." icon={<Bot className="w-4 h-4" />} />
          <InputField label="Anthropic API Key" value={config.anthropicApiKey} onChange={(v) => setConfig({ anthropicApiKey: v })} type="password" placeholder="sk-ant-..." icon={<Bot className="w-4 h-4" />} />
          <InputField label="OpenRouter API Key" value={config.openrouterApiKey} onChange={(v) => setConfig({ openrouterApiKey: v })} type="password" placeholder="sk-or-..." icon={<Bot className="w-4 h-4" />} />
          <InputField label="Groq API Key" value={config.groqApiKey} onChange={(v) => setConfig({ groqApiKey: v })} type="password" placeholder="gsk_..." icon={<Zap className="w-4 h-4" />} />
        </div>
      </section>

      {/* Model Configuration */}
      <section className="glass-card rounded-2xl p-8 hover:shadow-lg transition-all duration-300 group">
        <h2 className="text-xl font-bold text-white mb-6 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-purple-500/20 flex items-center justify-center group-hover:scale-110 transition-transform duration-300">
            <Sparkles className="w-5 h-5 text-purple-400" />
          </div>
          AI Model Configuration
        </h2>
        <div className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">Primary Generation Model</label>
            <select
              value={config.primaryModel}
              onChange={(e) => setConfig({ primaryModel: e.target.value as any })}
              className="w-full md:w-80 px-4 py-2.5 bg-background border border-border rounded-xl text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              <option value="gemini">Google Gemini 2.5 Flash</option>
              <option value="openai">OpenAI GPT-4o</option>
              <option value="anthropic">Anthropic Claude Sonnet 4</option>
              <option value="openrouter">OpenRouter (Custom Model)</option>
              <option value="groq">Groq (High-Speed)</option>
            </select>
          </div>

          {(config.primaryModel === 'openrouter' || config.openrouterApiKey) && (
            <div className="p-4 bg-background/50 border border-border rounded-xl space-y-3">
              <label className="block text-sm font-medium text-foreground">OpenRouter Model ID</label>
              <div className="flex gap-2">
                <select
                  value={showCustomOpenRouter ? 'custom' : config.openrouterModelId}
                  onChange={(e) => handleOpenRouterModelChange(e.target.value)}
                  className="flex-1 px-4 py-2.5 bg-background border border-border rounded-xl text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                >
                  {OPENROUTER_MODELS.map(m => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                  <option value="custom">Custom Model ID...</option>
                </select>
              </div>
              {showCustomOpenRouter && (
                <div className="flex gap-2">
                  <input type="text" value={customOpenRouterModel} onChange={(e) => setCustomOpenRouterModel(e.target.value)} placeholder="e.g., anthropic/claude-3.5-sonnet:beta" className="flex-1 px-4 py-2.5 bg-background border border-border rounded-xl text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50" />
                  <button onClick={handleCustomOpenRouterSubmit} className="px-4 py-2 bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 transition-colors">Set</button>
                </div>
              )}
              <p className="text-xs text-muted-foreground">Current: <code className="text-primary">{config.openrouterModelId}</code></p>
            </div>
          )}

          {(config.primaryModel === 'groq' || config.groqApiKey) && (
            <div className="p-4 bg-background/50 border border-border rounded-xl space-y-3">
              <label className="block text-sm font-medium text-foreground">Groq Model ID</label>
              <div className="flex gap-2">
                <select
                  value={showCustomGroq ? 'custom' : config.groqModelId}
                  onChange={(e) => handleGroqModelChange(e.target.value)}
                  className="flex-1 px-4 py-2.5 bg-background border border-border rounded-xl text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                >
                  {GROQ_MODELS.map(m => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                  <option value="custom">Custom Model ID...</option>
                </select>
              </div>
              {showCustomGroq && (
                <div className="flex gap-2">
                  <input type="text" value={customGroqModel} onChange={(e) => setCustomGroqModel(e.target.value)} placeholder="e.g., llama3-groq-70b-8192-tool-use-preview" className="flex-1 px-4 py-2.5 bg-background border border-border rounded-xl text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50" />
                  <button onClick={handleCustomGroqSubmit} className="px-4 py-2 bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 transition-colors">Set</button>
                </div>
              )}
              <p className="text-xs text-muted-foreground">Current: <code className="text-primary">{config.groqModelId}</code></p>
            </div>
          )}

          {/* Fallback Models */}
          <div className="p-4 bg-background/50 border border-border rounded-xl space-y-4">
            <div>
              <label className="block text-sm font-medium text-foreground">Fallback Models</label>
              <p className="text-xs text-muted-foreground mt-1">Add backup models tried in order when the primary fails. You can add multiple models from the same provider (e.g., several OpenRouter models).</p>
            </div>

            {/* Current fallback list */}
            {(config.fallbackModels || []).length > 0 && (
              <div className="space-y-2">
                {(config.fallbackModels || []).map((entry, idx) => {
                  const colonIdx = entry.indexOf(':');
                  const provider = colonIdx > 0 ? entry.substring(0, colonIdx) : entry;
                  const modelId = colonIdx > 0 ? entry.substring(colonIdx + 1) : '(default)';
                  return (
                    <div key={`${entry}-${idx}`} className="flex items-center gap-2 px-3 py-2 bg-background/30 border border-border/40 rounded-lg">
                      <span className="text-xs font-mono text-primary/80 w-5 text-center">{idx + 1}</span>
                      <span className="text-xs font-semibold text-foreground uppercase">{provider}</span>
                      <span className="text-xs text-muted-foreground">→</span>
                      <span className="text-xs text-foreground flex-1 font-mono">{modelId}</span>
                      <button
                        onClick={() => {
                          const updated = [...(config.fallbackModels || [])];
                          if (idx > 0) { [updated[idx - 1], updated[idx]] = [updated[idx], updated[idx - 1]]; setConfig({ fallbackModels: updated }); }
                        }}
                        disabled={idx === 0}
                        className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
                        title="Move up"
                      >↑</button>
                      <button
                        onClick={() => {
                          const updated = [...(config.fallbackModels || [])];
                          if (idx < updated.length - 1) { [updated[idx], updated[idx + 1]] = [updated[idx + 1], updated[idx]]; setConfig({ fallbackModels: updated }); }
                        }}
                        disabled={idx === (config.fallbackModels || []).length - 1}
                        className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
                        title="Move down"
                      >↓</button>
                      <button
                        onClick={() => setConfig({ fallbackModels: (config.fallbackModels || []).filter((_, i) => i !== idx) })}
                        className="text-xs text-red-400/70 hover:text-red-400 transition-colors"
                        title="Remove"
                      >
                        <XCircle className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Add new fallback */}
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex-shrink-0">
                <label className="block text-xs text-muted-foreground mb-1">Provider</label>
                <select
                  value={fbProvider}
                  onChange={(e) => { setFbProvider(e.target.value); setFbModelId(''); setFbShowCustom(false); }}
                  className="px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                >
                  <option value="openrouter">OpenRouter</option>
                  <option value="gemini">Gemini</option>
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="groq">Groq</option>
                </select>
              </div>

              <div className="flex-1 min-w-[200px]">
                <label className="block text-xs text-muted-foreground mb-1">Model ID</label>
                {fbProvider === 'openrouter' && !fbShowCustom ? (
                  <select
                    value={fbModelId}
                    onChange={(e) => { if (e.target.value === '__custom__') { setFbShowCustom(true); setFbModelId(''); } else { setFbModelId(e.target.value); } }}
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                  >
                    <option value="">Select model...</option>
                    {OPENROUTER_MODELS.map(m => <option key={m.id} value={m.id}>{m.name} ({m.id})</option>)}
                    <option value="__custom__">Custom model ID...</option>
                  </select>
                ) : fbProvider === 'groq' && !fbShowCustom ? (
                  <select
                    value={fbModelId}
                    onChange={(e) => { if (e.target.value === '__custom__') { setFbShowCustom(true); setFbModelId(''); } else { setFbModelId(e.target.value); } }}
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                  >
                    <option value="">Select model...</option>
                    {GROQ_MODELS.map(m => <option key={m.id} value={m.id}>{m.name} ({m.id})</option>)}
                    <option value="__custom__">Custom model ID...</option>
                  </select>
                ) : (
                  <input
                    type="text"
                    value={fbShowCustom ? fbCustomModelId : fbModelId}
                    onChange={(e) => fbShowCustom ? setFbCustomModelId(e.target.value) : setFbModelId(e.target.value)}
                    placeholder={fbProvider === 'openrouter' ? 'e.g., anthropic/claude-3.5-sonnet:beta' : fbProvider === 'gemini' ? 'e.g., gemini-2.5-flash' : 'Enter model ID...'}
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                )}
              </div>

              <button
                onClick={() => {
                  const modelId = fbShowCustom ? fbCustomModelId.trim() : fbModelId.trim();
                  if (!modelId) return;
                  const entry = `${fbProvider}:${modelId}`;
                  if ((config.fallbackModels || []).includes(entry)) {
                    toast.error('This fallback model is already added.');
                    return;
                  }
                  setConfig({ fallbackModels: [...(config.fallbackModels || []), entry] });
                  setFbModelId('');
                  setFbCustomModelId('');
                  setFbShowCustom(false);
                  toast.success(`Added ${fbProvider}:${modelId} as fallback #${(config.fallbackModels || []).length + 1}`);
                }}
                disabled={!(fbShowCustom ? fbCustomModelId.trim() : fbModelId.trim())}
                className={cn(
                  "px-4 py-2 rounded-lg text-sm font-semibold transition-all border",
                  (fbShowCustom ? fbCustomModelId.trim() : fbModelId.trim())
                    ? "bg-primary text-primary-foreground border-primary hover:bg-primary/90"
                    : "bg-muted text-muted-foreground border-border cursor-not-allowed"
                )}
              >
                Add
              </button>

              {(config.fallbackModels || []).length > 0 && (
                <button
                  onClick={() => { setConfig({ fallbackModels: [] }); toast.success('All fallback models cleared.'); }}
                  className="px-3 py-2 rounded-lg text-sm font-medium border border-border/50 text-red-400/70 hover:text-red-400 hover:border-red-400/30 transition-all"
                >
                  Clear All
                </button>
              )}
            </div>

            {fbShowCustom && (
              <button onClick={() => { setFbShowCustom(false); setFbCustomModelId(''); }} className="text-xs text-primary hover:underline">
                ← Back to preset list
              </button>
            )}
          </div>

          <label className="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" checked={config.enableGoogleGrounding} onChange={(e) => setConfig({ enableGoogleGrounding: e.target.checked })} className="w-5 h-5 rounded border-border text-primary focus:ring-primary/50" />
            <span className="text-sm text-foreground">Enable Google Search Grounding</span>
          </label>
        </div>
      </section>

      {/* Supabase Configuration */}
      <section className="glass-card rounded-2xl p-8 hover:shadow-lg transition-all duration-300 group">
        <h2 className="text-xl font-bold text-white mb-2 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/20 flex items-center justify-center group-hover:scale-110 transition-transform duration-300">
            <Database className="w-5 h-5 text-emerald-400" />
          </div>
          Supabase Database
        </h2>
        <p className="text-muted-foreground text-sm mb-6">
          Persists your generated content, NeuronWriter analysis, and publishing history across sessions and devices.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <InputField label="Supabase Project URL" value={sbUrl} onChange={(v) => setSbUrl(v)} placeholder="https://xxxx.supabase.co" icon={<Globe className="w-4 h-4" />} />
          <InputField label="Supabase Anon Key" value={sbAnonKey} onChange={(v) => setSbAnonKey(v)} placeholder="eyJhbGciOi..." icon={<Key className="w-4 h-4" />} type="password" />
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button onClick={handleSaveSupabase} disabled={!sbStatus.configured} className={cn("px-5 py-2.5 rounded-xl font-semibold transition-all premium-ring", sbStatus.configured ? "bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg" : "bg-muted text-muted-foreground cursor-not-allowed")}>Save</button>
          <button onClick={handleReloadAfterSupabase} disabled={!sbStatus.configured} className={cn("px-5 py-2.5 rounded-xl font-semibold transition-all premium-ring border", sbStatus.configured ? "border-border/60 bg-background/30 hover:bg-background/45" : "border-border/30 bg-background/10 text-muted-foreground cursor-not-allowed")}>Save & Reload</button>
          <button onClick={handleTestSupabase} className="px-5 py-2.5 rounded-xl font-semibold transition-all premium-ring border border-border/60 bg-background/10 hover:bg-background/25">Test Connection</button>
          <button onClick={handleClearSupabase} className="px-5 py-2.5 rounded-xl font-semibold transition-all premium-ring border border-border/60 bg-background/10 hover:bg-background/25 text-red-400/70 hover:text-red-400">Clear</button>
          <div className="ml-auto flex items-center gap-2 text-sm">
            {sbStatus.configured ? (
              <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 font-medium"><Check className="w-4 h-4" />Connected</span>
            ) : (
              <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 font-medium"><AlertCircle className="w-4 h-4" />Not configured</span>
            )}
          </div>
        </div>
        {!sbStatus.configured && sbStatus.issues.length > 0 && (
          <div className="mt-4 p-3 bg-amber-500/5 border border-amber-500/15 rounded-xl text-sm text-muted-foreground">
            <div className="font-medium text-amber-400 mb-1">What to fix:</div>
            <ul className="list-disc pl-5 space-y-1">
              {sbStatus.issues.map((issue) => (<li key={issue}>{issue}</li>))}
            </ul>
          </div>
        )}
      </section>

      {/* WordPress Configuration */}
      <section className="bg-card border border-border rounded-2xl p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
          <Globe className="w-5 h-5 text-primary" />
          WordPress & Site Information
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <InputField label="WordPress Site URL" value={config.wpUrl} onChange={(v) => setConfig({ wpUrl: v })} placeholder="https://your-site.com" icon={<Globe className="w-4 h-4" />} />
          <InputField label="WordPress Username" value={config.wpUsername} onChange={(v) => setConfig({ wpUsername: v })} placeholder="admin" icon={<User className="w-4 h-4" />} />
          <InputField label="WordPress Application Password" value={config.wpAppPassword} onChange={(v) => setConfig({ wpAppPassword: v })} type="password" placeholder="xxxx xxxx xxxx xxxx" icon={<Key className="w-4 h-4" />} />
          <InputField label="Organization Name" value={config.organizationName} onChange={(v) => setConfig({ organizationName: v })} placeholder="Your Company" icon={<Building className="w-4 h-4" />} />
          <InputField label="Logo URL" value={config.logoUrl} onChange={(v) => setConfig({ logoUrl: v })} placeholder="https://..." icon={<Image className="w-4 h-4" />} />
          <InputField label="Author Name" value={config.authorName} onChange={(v) => setConfig({ authorName: v })} placeholder="John Doe" icon={<UserCircle className="w-4 h-4" />} />
        </div>
        <div className="mt-4 flex items-center gap-3">
          <a href={config.wpUrl || "#"} target="_blank" rel="noopener noreferrer" className={cn("text-sm text-primary hover:underline flex items-center gap-1", !config.wpUrl && "pointer-events-none opacity-50")}>
            Learn More <ExternalLink className="w-3 h-3" />
          </a>
          <button onClick={handleVerifyWordPress} disabled={verifyingWp || !config.wpUrl || !config.wpUsername || !config.wpAppPassword} className={cn("px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2", wpVerified === true ? "bg-green-500/20 text-green-400 border border-green-500/30" : wpVerified === false ? "bg-red-500/20 text-red-400 border border-red-500/30" : "bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50")}>
            {verifyingWp ? "Verifying..." : wpVerified === true ? (<><Check className="w-4 h-4" /> Verified</>) : wpVerified === false ? (<><AlertCircle className="w-4 h-4" /> Failed</>) : "Verify WordPress"}
          </button>
        </div>
      </section>

      {/* NeuronWriter Integration — SOTA */}
      <section className="glass-card rounded-2xl p-6 md:p-8 hover:shadow-lg transition-all duration-300 group relative overflow-hidden">
        <div
          className="pointer-events-none absolute -top-20 -right-20 w-60 h-60 rounded-full opacity-30 blur-3xl"
          style={{ background: "radial-gradient(closest-side, hsla(160,84%,39%,0.18), transparent)" }}
        />

        {/* Header with live connection status */}
        <div className="relative flex flex-col md:flex-row md:items-start md:justify-between gap-3 mb-5">
          <div className="flex items-start gap-3">
            <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-primary/25 to-emerald-700/15 border border-primary/30 flex items-center justify-center shadow-md shadow-primary/15 ring-1 ring-white/5 group-hover:scale-105 transition-transform duration-300">
              <Sparkles className="w-5 h-5 text-primary" />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg md:text-xl font-bold text-foreground tracking-tight">NeuronWriter Integration</h2>
              <p className="text-xs md:text-sm text-muted-foreground mt-0.5 leading-relaxed">
                Pull live SERP terms, entities, and competitor headings to score &gt;90/100 on every post.
              </p>
            </div>
          </div>

          {/* Status pill */}
          <div className="flex flex-wrap items-center gap-2">
            <ConnectionStatusPill
              enabled={!!config.enableNeuronWriter}
              loading={neuronWriterLoading}
              error={!!neuronWriterError}
              hasKey={!!(config.neuronWriterApiKey && config.neuronWriterApiKey.trim().length >= 10)}
              projects={neuronWriterProjects.length}
              selected={!!config.neuronWriterProjectId}
            />
            <a
              href="https://app.neuronwriter.com/ncapi/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-muted-foreground hover:text-primary inline-flex items-center gap-1 underline-offset-2 hover:underline"
            >
              Get API key <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>

        <label className="flex items-center gap-3 cursor-pointer mb-4 p-3 rounded-xl bg-background/40 border border-border/40 hover:border-primary/30 transition-colors">
          <input
            type="checkbox"
            checked={config.enableNeuronWriter}
            onChange={(e) => {
              const enabled = e.target.checked;
              setConfig({ enableNeuronWriter: enabled });
              if (enabled && config.neuronWriterApiKey && config.neuronWriterApiKey.trim().length >= 10) {
                // Optimistic: flip to "Connecting…" instantly while debounced fetch warms up.
                setNeuronWriterError(null);
                setNeuronWriterLoading(true);
              } else if (!enabled) {
                setNeuronWriterLoading(false);
                setNeuronWriterError(null);
              }
            }}
            className="w-5 h-5 rounded border-border text-primary focus:ring-primary/50"
          />
          <div className="min-w-0 flex-1">
            <span className="text-sm font-semibold text-foreground block">Enable NeuronWriter</span>
            <span className="text-[11px] text-muted-foreground">
              When on, every generation pulls live SEO terms + entities for the target keyword.
            </span>
          </div>
        </label>

        {config.enableNeuronWriter && (
          <div className="space-y-4 animate-fade-in">
            <InputField
              label="NeuronWriter API Key"
              value={config.neuronWriterApiKey}
              onChange={(v) => setConfig({ neuronWriterApiKey: v })}
              type="password"
              placeholder="Enter NeuronWriter key..."
              icon={<Key className="w-4 h-4" />}
            />

            {/* Key too short warning */}
            {config.neuronWriterApiKey && config.neuronWriterApiKey.trim().length > 0 && config.neuronWriterApiKey.trim().length < 10 && (
              <div className="flex items-center gap-2 text-xs text-amber-300/90 bg-amber-500/10 border border-amber-500/25 rounded-xl px-3 py-2">
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                <span>API key looks too short — paste the full key from NeuronWriter → Account → API.</span>
              </div>
            )}

            {/* Project picker block */}
            {config.neuronWriterApiKey && config.neuronWriterApiKey.trim().length >= 10 && (
              <div className="p-4 md:p-5 bg-background/40 border border-border/60 rounded-2xl space-y-3">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <label className="text-sm font-semibold text-foreground flex items-center gap-2">
                    <FolderOpen className="w-4 h-4 text-primary" />
                    Project
                    {neuronWriterProjects.length > 0 && (
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-md bg-primary/15 text-primary border border-primary/25">
                        {neuronWriterProjects.length}
                      </span>
                    )}
                  </label>
                  <button
                    onClick={() => fetchNeuronWriterProjects(config.neuronWriterApiKey)}
                    disabled={neuronWriterLoading}
                    className="text-xs text-primary hover:text-primary/80 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg hover:bg-primary/10 transition-colors disabled:opacity-50 font-semibold"
                  >
                    <RefreshCw className={cn("w-3.5 h-3.5", neuronWriterLoading && "animate-spin")} />
                    {neuronWriterLoading ? "Loading…" : "Refresh"}
                  </button>
                </div>

                {/* Loading skeleton — only when no cached projects to show */}
                {neuronWriterLoading && neuronWriterProjects.length === 0 && (
                  <div className="space-y-2 animate-fade-in" aria-busy="true">
                    <div className="h-11 rounded-xl bg-white/5 border border-white/10 animate-shimmer" />
                    <div className="h-9 rounded-xl bg-white/5 border border-white/10 animate-shimmer" />
                    <div className="flex items-center gap-2 text-[11px] text-primary/80">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Connecting to NeuronWriter…
                    </div>
                  </div>
                )}

                {/* Error */}
                {!neuronWriterLoading && neuronWriterError && (
                  <div className="p-3 bg-red-500/10 border border-red-500/25 rounded-xl">
                    <div className="flex items-start gap-2.5">
                      <XCircle className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-red-300">Couldn't reach NeuronWriter</p>
                        <p className="text-xs text-red-300/70 mt-0.5 break-words">{neuronWriterError}</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <button
                            onClick={() => fetchNeuronWriterProjects(config.neuronWriterApiKey)}
                            className="text-xs text-red-200 hover:text-white bg-red-500/20 hover:bg-red-500/30 px-2.5 py-1 rounded-md font-semibold"
                          >
                            Retry
                          </button>
                          <a
                            href="https://app.neuronwriter.com/"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-red-300/80 hover:text-red-200 px-2.5 py-1 rounded-md inline-flex items-center gap-1"
                          >
                            Check NW status <ExternalLink className="w-3 h-3" />
                          </a>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Project list — kept visible during refresh (optimistic stale-while-revalidate) */}
                {!neuronWriterError && neuronWriterProjects.length > 0 && (
                  <div className={cn("space-y-2 transition-opacity", neuronWriterLoading && "opacity-60")}>
                    <select
                      value={config.neuronWriterProjectId}
                      onChange={(e) => handleProjectSelect(e.target.value)}
                      className="w-full px-4 py-2.5 bg-background border border-border rounded-xl text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm"
                    >
                      <option value="">Select a project…</option>
                      {neuronWriterProjects.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.name}
                          {project.queries_count !== undefined && ` · ${project.queries_count} queries`}
                        </option>
                      ))}
                    </select>
                    {neuronWriterLoading && (
                      <div className="flex items-center gap-1.5 text-[11px] text-primary/80">
                        <Loader2 className="w-3 h-3 animate-spin" /> Refreshing…
                      </div>
                    )}
                    {!neuronWriterLoading && config.neuronWriterProjectId && (
                      <div className="flex items-center gap-2 text-emerald-300 text-sm p-2.5 bg-emerald-500/10 border border-emerald-500/25 rounded-xl">
                        <Check className="w-4 h-4 flex-shrink-0" />
                        <span className="min-w-0 truncate">
                          Connected to <strong className="font-bold">{config.neuronWriterProjectName}</strong>
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {/* No projects */}
                {!neuronWriterLoading && !neuronWriterError && neuronWriterProjects.length === 0 && nwFetchAttempted && (
                  <div className="p-3 bg-amber-500/10 border border-amber-500/25 rounded-xl">
                    <div className="flex items-start gap-2.5">
                      <AlertCircle className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
                      <div>
                        <p className="text-sm font-semibold text-amber-300">No projects yet</p>
                        <p className="text-xs text-amber-300/70 mt-0.5">
                          Create a project in NeuronWriter, then click Refresh.
                        </p>
                        <a
                          href="https://app.neuronwriter.com/"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-amber-200 hover:text-amber-100"
                        >
                          Open NeuronWriter <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>
                    </div>
                  </div>
                )}

                {/* Idle */}
                {!neuronWriterLoading && !neuronWriterError && neuronWriterProjects.length === 0 && !nwFetchAttempted && (
                  <button
                    onClick={() => fetchNeuronWriterProjects(config.neuronWriterApiKey)}
                    className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border border-dashed border-border/60 text-sm text-muted-foreground hover:text-primary hover:border-primary/40 hover:bg-primary/5 transition-colors"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Load projects
                  </button>
                )}
              </div>
            )}

            {/* Feature highlights */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {[
                { label: "Live SERP terms", desc: "Required + recommended keywords" },
                { label: "Named entities", desc: "Topical authority signals" },
                { label: "Competitor H2s", desc: "Structure that ranks" },
              ].map((f) => (
                <div
                  key={f.label}
                  className="px-3 py-2 rounded-xl bg-background/30 border border-border/40 text-[11px]"
                >
                  <div className="font-bold text-foreground/90 flex items-center gap-1.5">
                    <Check className="w-3 h-3 text-primary" />
                    {f.label}
                  </div>
                  <div className="text-muted-foreground/70 mt-0.5">{f.desc}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* Geo-Targeting */}
      <section className="bg-card border border-border rounded-2xl p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
          <MapPin className="w-5 h-5 text-primary" />
          Advanced Geo-Targeting
        </h2>
        <label className="flex items-center gap-3 cursor-pointer">
          <input type="checkbox" checked={config.enableGeoTargeting} onChange={(e) => setConfig({ enableGeoTargeting: e.target.checked })} className="w-5 h-5 rounded border-border text-primary focus:ring-primary/50" />
          <span className="text-sm text-foreground">Enable Geo-Targeting for Content</span>
        </label>
        {config.enableGeoTargeting && (
          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">Target Country</label>
              <select value={config.targetCountry} onChange={(e) => setConfig({ targetCountry: e.target.value })} className="w-full px-4 py-2.5 bg-background border border-border rounded-xl text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50">
                <option value="US">United States</option>
                <option value="UK">United Kingdom</option>
                <option value="CA">Canada</option>
                <option value="AU">Australia</option>
                <option value="DE">Germany</option>
                <option value="FR">France</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">Target Language</label>
              <select value={config.targetLanguage} onChange={(e) => setConfig({ targetLanguage: e.target.value })} className="w-full px-4 py-2.5 bg-background border border-border rounded-xl text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50">
                <option value="en">English</option>
                <option value="es">Spanish</option>
                <option value="de">German</option>
                <option value="fr">French</option>
              </select>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function InputField({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  icon,
  required,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
  icon?: React.ReactNode;
  required?: boolean;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-foreground mb-2">
        {label}
        {required && <span className="text-red-400 ml-1">*</span>}
      </label>
      <div className="relative group">
        {icon && (
          <div className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 group-hover:text-primary transition-colors duration-300 z-10">{icon}</div>
        )}
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={cn(
            "w-full px-4 py-3 bg-black/20 backdrop-blur-sm border border-white/10 rounded-xl text-white placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/50 transition-all duration-300 shadow-inner group-hover:bg-black/30",
            icon && "pl-10"
          )}
        />
      </div>
    </div>
  );
}

function ConnectionStatusPill({
  enabled,
  loading,
  error,
  hasKey,
  projects,
  selected,
}: {
  enabled: boolean;
  loading: boolean;
  error: boolean;
  hasKey: boolean;
  projects: number;
  selected: boolean;
}) {
  let label = "Disabled";
  let tone = "bg-zinc-500/15 text-zinc-300 ring-zinc-400/30";
  let dot = "bg-zinc-400";

  if (enabled) {
    if (loading) {
      label = "Connecting…";
      tone = "bg-blue-500/15 text-blue-300 ring-blue-400/30";
      dot = "bg-blue-400 animate-pulse";
    } else if (error) {
      label = "Error";
      tone = "bg-red-500/15 text-red-300 ring-red-400/30";
      dot = "bg-red-400";
    } else if (!hasKey) {
      label = "Add API key";
      tone = "bg-amber-500/15 text-amber-300 ring-amber-400/30";
      dot = "bg-amber-400";
    } else if (selected) {
      label = "Connected";
      tone = "bg-emerald-500/15 text-emerald-300 ring-emerald-400/30";
      dot = "bg-emerald-400";
    } else if (projects > 0) {
      label = "Pick a project";
      tone = "bg-amber-500/15 text-amber-300 ring-amber-400/30";
      dot = "bg-amber-400";
    } else {
      label = "Ready";
      tone = "bg-primary/15 text-primary ring-primary/30";
      dot = "bg-primary";
    }
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ring-1",
        tone
      )}
    >
      <span className={cn("w-1.5 h-1.5 rounded-full", dot)} />
      {label}
    </span>
  );
}

function SetupStat({ label, ok, optional }: { label: string; ok: boolean; optional?: boolean }) {
  const tone = ok
    ? "from-emerald-400/15 ring-emerald-400/30 text-emerald-300"
    : optional
    ? "from-white/5 ring-white/10 text-zinc-400"
    : "from-amber-400/10 ring-amber-400/30 text-amber-300";
  return (
    <div className={cn(
      "rounded-xl md:rounded-2xl px-3 py-2 md:px-3.5 md:py-2.5 ring-1 bg-gradient-to-br to-transparent flex flex-col items-start min-w-[64px]",
      tone
    )}>
      <span className="text-[9px] md:text-[10px] uppercase tracking-[0.18em] font-bold opacity-80">{label}</span>
      <span className="text-base md:text-lg font-black tabular-nums leading-tight mt-0.5 flex items-center gap-1">
        {ok ? <Check className="w-4 h-4" /> : optional ? "—" : <AlertCircle className="w-4 h-4" />}
      </span>
    </div>
  );
}
