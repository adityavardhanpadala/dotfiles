import { complete, createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type Context, type ImageContent, type Message, type Model, type SimpleStreamOptions } from "@mariozechner/pi-ai";
import {
	createAgentSession,
	createExtensionRuntime,
	createReadOnlyTools,
	defineTool,
	ModelRegistry,
	SessionManager,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
	type ResourceLoader,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const FUSION_PROVIDER = "fusion";
const FUSION_MODEL_ID = "audit";
const FUSION_STATE_ENTRY = "fusion-state";
const MAX_TOOL_OUTPUT_BYTES = 50 * 1024;
const MAX_TOOL_OUTPUT_LINES = 2000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 30_000;
const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const CANDIDATE_SYSTEM_PROMPT = [
	"You are one of two independent audit models in fusion mode.",
	"Your job is to inspect existing project data and produce the best possible analysis.",
	"You may only use read-only tools and must never attempt to modify files, git state, dependencies, builds, or any external system.",
	"Use tools when needed to inspect evidence. Prefer read/grep/find/ls first. Use audit_bash only for strictly read-only shell inspection.",
	"End with a concise report that covers: findings, evidence, uncertainties, and your direct answer to the user.",
].join("\n");

const FUSION_SYSTEM_PROMPT = [
	"You are given a user request and two candidate answers.",
	"Write the best possible final answer for the user.",
	"Use the strongest parts of each answer, correct mistakes, and do not mention the candidates.",
].join("\n");

const READ_ONLY_COMMANDS = new Set(["git", "rg", "find", "ls", "pwd", "head", "tail", "wc", "stat", "file"]);
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
	"status",
	"diff",
	"log",
	"show",
	"rev-parse",
	"branch",
	"ls-files",
	"grep",
	"blame",
]);
const FORBIDDEN_FIND_ARGS = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprintf", "-fls"]);
const FORBIDDEN_GIT_ARGS = new Set(["-c", "--config-env", "--exec-path", "--output", "-o"]);

type ModelRef = {
	provider: string;
	id: string;
};

type FusionState = {
	enabled: boolean;
	modelA?: ModelRef;
	modelB?: ModelRef;
	fusionModel?: ModelRef;
	updatedAt: number;
};

type UsageTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
};

type CandidateResult = {
	label: "A" | "B";
	modelRef: ModelRef;
	finalText: string;
	toolSummary: string[];
	filesRead: string[];
	commandsRun: string[];
	assistantMessages: AssistantMessage[];
	usage: UsageTotals;
	error?: string;
	skipped?: string;
};

type PromptReplay = {
	history: Message[];
	promptText: string;
	promptImages: ImageContent[];
};

type LiveStage = "idle" | "running" | "done" | "error";

const zeroUsage = (): UsageTotals => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const addUsage = (target: UsageTotals, source?: Partial<UsageTotals>) => {
	if (!source) return;
	target.input += source.input ?? 0;
	target.output += source.output ?? 0;
	target.cacheRead += source.cacheRead ?? 0;
	target.cacheWrite += source.cacheWrite ?? 0;
	target.totalTokens += source.totalTokens ?? 0;
	target.cost.input += source.cost?.input ?? 0;
	target.cost.output += source.cost?.output ?? 0;
	target.cost.cacheRead += source.cost?.cacheRead ?? 0;
	target.cost.cacheWrite += source.cost?.cacheWrite ?? 0;
	target.cost.total += source.cost?.total ?? 0;
};

const usageFromAssistant = (message?: AssistantMessage): UsageTotals => ({
	input: message?.usage?.input ?? 0,
	output: message?.usage?.output ?? 0,
	cacheRead: message?.usage?.cacheRead ?? 0,
	cacheWrite: message?.usage?.cacheWrite ?? 0,
	totalTokens: message?.usage?.totalTokens ?? 0,
	cost: {
		input: message?.usage?.cost?.input ?? 0,
		output: message?.usage?.cost?.output ?? 0,
		cacheRead: message?.usage?.cost?.cacheRead ?? 0,
		cacheWrite: message?.usage?.cost?.cacheWrite ?? 0,
		total: message?.usage?.cost?.total ?? 0,
	},
});

const formatModelRef = (ref?: ModelRef) => (ref ? `${ref.provider}/${ref.id}` : "(unset)");

const parseModelRef = (value: string): ModelRef | undefined => {
	const slashIndex = value.indexOf("/");
	if (slashIndex <= 0 || slashIndex === value.length - 1) return undefined;
	return { provider: value.slice(0, slashIndex), id: value.slice(slashIndex + 1) };
};

const modelToRef = (model?: Model<any>): ModelRef | undefined =>
	model
		? {
				provider: model.provider,
				id: model.id,
			}
		: undefined;

const extractText = (content: Message["content"] | AssistantMessage["content"] | undefined): string => {
	if (!content || !Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.trim();
};

const messageHasImages = (message: Message) =>
	Array.isArray(message.content) && message.content.some((part) => part?.type === "image");

const contextHasImages = (messages: Message[]) => messages.some((message) => message.role === "user" && messageHasImages(message));

const supportsImages = (model: Model<any>) => Array.isArray(model.input) && model.input.includes("image");

const truncateOutput = (text: string): { text: string; truncated: boolean } => {
	const normalized = text.replace(/\r\n/g, "\n");
	const lines = normalized.split("\n");
	let limited = lines.slice(0, MAX_TOOL_OUTPUT_LINES).join("\n");
	let truncated = lines.length > MAX_TOOL_OUTPUT_LINES;
	const bytes = Buffer.byteLength(limited, "utf8");
	if (bytes > MAX_TOOL_OUTPUT_BYTES) {
		limited = Buffer.from(limited, "utf8").subarray(0, MAX_TOOL_OUTPUT_BYTES).toString("utf8");
		truncated = true;
	}
	if (truncated) {
		limited = `${limited}\n\n[truncated: max ${MAX_TOOL_OUTPUT_LINES} lines or ${MAX_TOOL_OUTPUT_BYTES} bytes]`;
	}
	return { text: limited, truncated };
};

const stringifyCommand = (command: string, args: string[]) => [command, ...args].join(" ").trim();

const validateAuditCommand = (command: string, args: string[]): string | undefined => {
	if (!READ_ONLY_COMMANDS.has(command)) {
		return `Command ${command} is not allowed in fusion audit mode.`;
	}
	for (const arg of args) {
		if (arg.includes("\n") || arg.includes("\0")) return "Arguments must not contain newlines or NUL bytes.";
	}
	if (command === "git") {
		if (args.length === 0) return "git requires a read-only subcommand.";
		if (args[0].startsWith("-")) return "git global flags are not allowed in fusion audit mode.";
		if (!READ_ONLY_GIT_SUBCOMMANDS.has(args[0])) return `git ${args[0]} is not allowed in fusion audit mode.`;
		for (const arg of args.slice(1)) {
			if (FORBIDDEN_GIT_ARGS.has(arg)) return `git argument ${arg} is not allowed in fusion audit mode.`;
		}
	}
	if (command === "find") {
		for (const arg of args) {
			if (FORBIDDEN_FIND_ARGS.has(arg)) return `find argument ${arg} is not allowed in fusion audit mode.`;
		}
	}
	return undefined;
};

const makeResourceLoader = (systemPrompt: string): ResourceLoader => ({
	getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
	getSkills: () => ({ skills: [], diagnostics: [] }),
	getPrompts: () => ({ prompts: [], diagnostics: [] }),
	getThemes: () => ({ themes: [], diagnostics: [] }),
	getAgentsFiles: () => ({ agentsFiles: [] }),
	getSystemPrompt: () => systemPrompt,
	getAppendSystemPrompt: () => [],
	extendResources: () => {},
	reload: async () => {},
});

const replayPrompt = (messages: Message[]): PromptReplay => {
	if (messages.length === 0) {
		throw new Error("Fusion provider did not receive any messages.");
	}
	const last = messages[messages.length - 1];
	if (last.role !== "user") {
		throw new Error(`Fusion provider expected the last message to be user, got ${last.role}.`);
	}
	const promptText = extractText(last.content);
	const promptImages = last.content.filter((part): part is ImageContent => part.type === "image");
	return {
		history: messages.slice(0, -1),
		promptText,
		promptImages,
	};
};

const summarizeToolCalls = (messages: AssistantMessage[]) => {
	const filesRead = new Set<string>();
	const commandsRun = new Set<string>();
	const summary: string[] = [];
	for (const message of messages) {
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			if (part.name === "read") {
				const path = typeof part.arguments?.path === "string" ? part.arguments.path : undefined;
				if (path) filesRead.add(path);
				summary.push(path ? `read ${path}` : "read");
				continue;
			}
			if (part.name === "audit_bash") {
				const command = typeof part.arguments?.command === "string" ? part.arguments.command : "";
				const args = Array.isArray(part.arguments?.args)
					? part.arguments.args.filter((value): value is string => typeof value === "string")
					: [];
				const rendered = stringifyCommand(command, args);
				if (rendered) commandsRun.add(rendered);
				summary.push(rendered || "audit_bash");
				continue;
			}
			if (part.name === "grep" || part.name === "find" || part.name === "ls") {
				summary.push(part.name);
			}
		}
	}
	return {
		filesRead: Array.from(filesRead),
		commandsRun: Array.from(commandsRun),
		summary,
	};
};

const pickPreferredModel = (available: Model<any>[], predicate: (model: Model<any>) => boolean, fallback?: Model<any>) => {
	const chosen = available.find(predicate);
	return chosen ?? fallback;
};

const buildFusionPrompt = (requestText: string, candidates: CandidateResult[]) => {
	const sections = [
		"<user_request>",
		requestText || "(no text prompt; the original turn may have included images)",
		"</user_request>",
	];
	for (const candidate of candidates) {
		sections.push("");
		sections.push(`<answer_${candidate.label.toLowerCase()}>`);
		sections.push(candidate.finalText.trim() || "(no final answer)");
		sections.push(`</answer_${candidate.label.toLowerCase()}>`);
	}
	return sections.join("\n");
};

const normalizeState = (value: unknown): FusionState | undefined => {
	if (!value || typeof value !== "object") return undefined;
	const data = value as Partial<FusionState>;
	const normalizeRef = (ref: unknown): ModelRef | undefined => {
		if (!ref || typeof ref !== "object") return undefined;
		const candidate = ref as Partial<ModelRef>;
		if (typeof candidate.provider !== "string" || typeof candidate.id !== "string") return undefined;
		return { provider: candidate.provider, id: candidate.id };
	};
	return {
		enabled: Boolean(data.enabled),
		modelA: normalizeRef(data.modelA),
		modelB: normalizeRef(data.modelB),
		fusionModel: normalizeRef(data.fusionModel),
		updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : Date.now(),
	};
};

const cloneMessage = <T,>(value: T): T => {
	if (typeof structuredClone === "function") {
		return structuredClone(value);
	}
	return JSON.parse(JSON.stringify(value)) as T;
};

export default function fusionExtension(pi: ExtensionAPI) {
	let state: FusionState = { enabled: false, updatedAt: Date.now() };
	let modelRegistry: ModelRegistry | undefined;
	let sessionCwd = process.cwd();
	let switchingModel = false;
	let startupRestoreTimer: ReturnType<typeof setTimeout> | undefined;
	let liveStatusCtx: ExtensionContext | undefined;
	let liveStatusTimer: ReturnType<typeof setInterval> | undefined;
	let liveFrameIndex = 0;
	let liveStages: { A: LiveStage; B: LiveStage; Fusor: LiveStage } = { A: "idle", B: "idle", Fusor: "idle" };

	const persistState = () => {
		state.updatedAt = Date.now();
		pi.appendEntry<FusionState>(FUSION_STATE_ENTRY, state);
	};

	const renderLiveStage = (ctx: ExtensionContext, stage: LiveStage, offset: number) => {
		const theme = ctx.ui.theme;
		if (stage === "running") return theme.fg("accent", BRAILLE_FRAMES[(liveFrameIndex + offset) % BRAILLE_FRAMES.length]);
		if (stage === "done") return theme.fg("success", "✓");
		if (stage === "error") return theme.fg("error", "✗");
		return theme.fg("dim", "·");
	};

	const refreshLiveStatus = () => {
		if (!liveStatusCtx?.hasUI) return;
		const active = state.enabled && (liveStages.A !== "idle" || liveStages.B !== "idle" || liveStages.Fusor !== "idle");
		if (!active) {
			liveStatusCtx.ui.setStatus("fusion-live", undefined);
			return;
		}
		const theme = liveStatusCtx.ui.theme;
		liveStatusCtx.ui.setStatus(
			"fusion-live",
			[
				theme.fg("accent", "Fusion:"),
				theme.fg("dim", " A ") + renderLiveStage(liveStatusCtx, liveStages.A, 0),
				theme.fg("dim", " B ") + renderLiveStage(liveStatusCtx, liveStages.B, 3),
				theme.fg("dim", " Fusor ") + renderLiveStage(liveStatusCtx, liveStages.Fusor, 6),
			].join(""),
		);
	};

	const setLiveStages = (next: Partial<typeof liveStages>) => {
		liveStages = { ...liveStages, ...next };
		refreshLiveStatus();
	};

	const resetLiveStatus = () => {
		liveStages = { A: "idle", B: "idle", Fusor: "idle" };
		refreshLiveStatus();
	};

	const startLiveStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		liveStatusCtx = ctx;
		liveFrameIndex = 0;
		resetLiveStatus();
		if (liveStatusTimer) clearInterval(liveStatusTimer);
		liveStatusTimer = setInterval(() => {
			liveFrameIndex++;
			refreshLiveStatus();
		}, 80);
	};

	const stopLiveStatus = () => {
		if (liveStatusTimer) {
			clearInterval(liveStatusTimer);
			liveStatusTimer = undefined;
		}
		resetLiveStatus();
	};

	const updateStatus = (ctx?: ExtensionContext) => {
		if (!ctx?.hasUI) return;
		ctx.ui.setStatus("fusion", undefined);
	};

	const restoreState = (ctx: ExtensionContext) => {
		modelRegistry = ctx.modelRegistry;
		sessionCwd = ctx.cwd;
		let restored: FusionState | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === FUSION_STATE_ENTRY) {
				restored = normalizeState(entry.data) ?? restored;
			}
		}
		state = restored
			? {
					...restored,
					enabled: false,
				}
			: { enabled: false, updatedAt: Date.now() };
		updateStatus(ctx);
	};

	const branchEndsWithFusionModel = (ctx: ExtensionContext) => {
		const branch = ctx.sessionManager.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index] as { type: string; provider?: string; modelId?: string };
			if (entry.type !== "model_change") continue;
			return entry.provider === FUSION_PROVIDER && entry.modelId === FUSION_MODEL_ID;
		}
		return false;
	};

	const restorePrimaryModelAfterStartup = () => {
		if (startupRestoreTimer) clearTimeout(startupRestoreTimer);
		startupRestoreTimer = setTimeout(async () => {
			const primary = await resolveConfiguredModel(state.modelA);
			if (!primary) return;
			switchingModel = true;
			try {
				await pi.setModel(primary);
			} finally {
				switchingModel = false;
			}
		}, 0);
	};

	const resolveConfiguredModel = async (ref: ModelRef | undefined): Promise<Model<any> | undefined> => {
		if (!modelRegistry || !ref || ref.provider === FUSION_PROVIDER) return undefined;
		const model = modelRegistry.find(ref.provider, ref.id);
		if (!model) return undefined;
		const auth = await modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) return undefined;
		return model;
	};

	const getAvailableModels = async () => {
		if (!modelRegistry) return [] as Model<any>[];
		const available = await modelRegistry.getAvailable();
		return available.filter(
			(model) => model.provider !== FUSION_PROVIDER && Array.isArray(model.input) && model.input.includes("text"),
		);
	};

	const pickDefaults = async (primary: Model<any>) => {
		const available = await getAvailableModels();
		const primaryKey = `${primary.provider}/${primary.id}`;
		const secondary =
			pickPreferredModel(
				available,
				(model) => `${model.provider}/${model.id}` !== primaryKey && model.provider !== primary.provider,
			) ?? pickPreferredModel(available, (model) => `${model.provider}/${model.id}` !== primaryKey);
		const fuser =
			pickPreferredModel(
				available,
				(model) => model.reasoning && `${model.provider}/${model.id}` !== primaryKey && `${model.provider}/${model.id}` !== `${secondary?.provider}/${secondary?.id}`,
			) ?? pickPreferredModel(available, (model) => model.reasoning, secondary ?? primary);
		return { available, secondary, fuser };
	};

	const orderModelsForSelection = (available: Model<any>[], preferred: Array<ModelRef | undefined>) => {
		const preferredKeys = preferred.filter(Boolean).map((ref) => `${ref!.provider}/${ref!.id}`);
		const uniquePreferred = Array.from(new Set(preferredKeys));
		return [...available].sort((a, b) => {
			const aKey = `${a.provider}/${a.id}`;
			const bKey = `${b.provider}/${b.id}`;
			const aRank = uniquePreferred.indexOf(aKey);
			const bRank = uniquePreferred.indexOf(bKey);
			if (aRank !== -1 || bRank !== -1) {
				if (aRank === -1) return 1;
				if (bRank === -1) return -1;
				return aRank - bRank;
			}
			return aKey.localeCompare(bKey);
		});
	};

	const selectModelInteractive = async (
		ctx: ExtensionContext,
		title: string,
		available: Model<any>[],
		preferred: Array<ModelRef | undefined>,
	): Promise<Model<any> | undefined> => {
		const ordered = orderModelsForSelection(available, preferred);
		const labels = ordered.map((model) => {
			const ref = modelToRef(model)!;
			const key = formatModelRef(ref);
			const badges: string[] = [];
			if (preferred.some((item) => item?.provider === ref.provider && item?.id === ref.id)) badges.push("default");
			if (model.reasoning) badges.push("reasoning");
			if (supportsImages(model)) badges.push("image");
			return badges.length > 0 ? `${key} • ${badges.join(" • ")}` : key;
		});
		const selection = await ctx.ui.select(title, labels);
		if (!selection) return undefined;
		const index = labels.indexOf(selection);
		return index >= 0 ? ordered[index] : undefined;
	};

	const ensureFusionModel = async () => {
		const fusionModel = modelRegistry?.find(FUSION_PROVIDER, FUSION_MODEL_ID);
		if (!fusionModel) return false;
		return pi.setModel(fusionModel);
	};

	const disableFusion = async (ctx: ExtensionContext) => {
		state.enabled = false;
		persistState();
		updateStatus(ctx);
		const primary = await resolveConfiguredModel(state.modelA);
		if (primary) {
			switchingModel = true;
			try {
				await pi.setModel(primary);
			} finally {
				switchingModel = false;
			}
		}
		if (ctx.hasUI) ctx.ui.notify("Fusion disabled", "info");
	};

	const enableFusion = async (ctx: ExtensionContext) => {
		if (!modelRegistry) {
			if (ctx.hasUI) ctx.ui.notify("Fusion unavailable: model registry not ready", "error");
			return;
		}
		const currentModel = ctx.model?.provider === FUSION_PROVIDER ? await resolveConfiguredModel(state.modelA) : ctx.model;
		if (!currentModel) {
			if (ctx.hasUI) ctx.ui.notify("Fusion requires a current base model", "error");
			return;
		}
		const defaults = await pickDefaults(currentModel);
		let modelA = (await resolveConfiguredModel(state.modelA)) ?? currentModel;
		let modelB = (await resolveConfiguredModel(state.modelB)) ?? defaults.secondary;
		let fusionModel = (await resolveConfiguredModel(state.fusionModel)) ?? defaults.fuser;
		if (ctx.hasUI) {
			const available = defaults.available;
			const selectedA = await selectModelInteractive(ctx, "Select Fusion model A", available, [state.modelA, modelToRef(currentModel)]);
			if (!selectedA) {
				ctx.ui.notify("Fusion enable canceled", "info");
				return;
			}
			modelA = selectedA;
			const selectedB = await selectModelInteractive(ctx, "Select Fusion model B", available, [state.modelB, modelToRef(modelB)]);
			if (!selectedB) {
				ctx.ui.notify("Fusion enable canceled", "info");
				return;
			}
			modelB = selectedB;
			const selectedFusion = await selectModelInteractive(ctx, "Select Fusion fusor model", available, [state.fusionModel, modelToRef(fusionModel)]);
			if (!selectedFusion) {
				ctx.ui.notify("Fusion enable canceled", "info");
				return;
			}
			fusionModel = selectedFusion;
		}
		if (!modelA || !modelB || !fusionModel) {
			if (ctx.hasUI) ctx.ui.notify("Fusion needs two candidate models and one fusion model", "error");
			return;
		}
		state = {
			enabled: true,
			modelA: modelToRef(modelA),
			modelB: modelToRef(modelB),
			fusionModel: modelToRef(fusionModel),
			updatedAt: Date.now(),
		};
		persistState();
		updateStatus(ctx);
		if (ctx.model?.provider === FUSION_PROVIDER) {
			const primary = await resolveConfiguredModel(state.modelA);
			if (primary) {
				switchingModel = true;
				try {
					await pi.setModel(primary);
				} finally {
					switchingModel = false;
				}
			}
		}
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Fusion enabled: A=${formatModelRef(state.modelA)} B=${formatModelRef(state.modelB)} F=${formatModelRef(state.fusionModel)}`,
				"success",
			);
		}
	};

	const formatStatus = () =>
		[
			`enabled: ${state.enabled}`,
			`modelA: ${formatModelRef(state.modelA)}`,
			`modelB: ${formatModelRef(state.modelB)}`,
			`fusionModel: ${formatModelRef(state.fusionModel)}`,
		].join("\n");

	const setConfiguredModel = async (
		ctx: ExtensionContext,
		key: "modelB" | "fusionModel",
		value: string,
		label: string,
	) => {
		const ref = parseModelRef(value);
		if (!ref) {
			if (ctx.hasUI) ctx.ui.notify(`Expected provider/id for ${label}`, "error");
			return;
		}
		if (ref.provider === FUSION_PROVIDER) {
			if (ctx.hasUI) ctx.ui.notify(`Fusion synthetic model cannot be used as ${label}`, "error");
			return;
		}
		const model = await resolveConfiguredModel(ref);
		if (!model) {
			if (ctx.hasUI) ctx.ui.notify(`Model not available for ${label}: ${value}`, "error");
			return;
		}
		state[key] = modelToRef(model);
		persistState();
		updateStatus(ctx);
		if (ctx.hasUI) ctx.ui.notify(`Updated ${label} to ${value}`, "success");
	};

	const auditBashTool = defineTool({
		name: "audit_bash",
		label: "Audit Bash",
		description: "Run a strictly read-only audit command. Allowed commands: git, rg, find, ls, pwd, head, tail, wc, stat, file.",
		promptSnippet: "Run read-only shell inspection commands when read/grep/find/ls are insufficient.",
		promptGuidelines: [
			"Use audit_bash only for strictly read-only inspection.",
			"Pass command and args as structured fields. Never expect shell features like pipes or redirects.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "Allowed command name" }),
			args: Type.Optional(Type.Array(Type.String(), { description: "Command arguments" })),
			timeoutMs: Type.Optional(Type.Number({ description: `Timeout in milliseconds. Max ${MAX_TIMEOUT_MS}.` })),
		}),
		async execute(_toolCallId, params, signal) {
			const args = params.args ?? [];
			const validationError = validateAuditCommand(params.command, args);
			if (validationError) {
				return {
					content: [{ type: "text", text: validationError }],
					details: { command: params.command, args },
					isError: true,
				};
			}
			const timeout = Math.max(1, Math.min(params.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
			const result = await pi.exec(params.command, args, { signal, timeout });
			const rawOutput = [result.stdout, result.stderr].filter(Boolean).join(result.stdout && result.stderr ? "\n" : "").trim();
			const { text, truncated } = truncateOutput(rawOutput || (result.code === 0 ? "(no output)" : "Command failed without output"));
			return {
				content: [{ type: "text", text }],
				details: {
					command: params.command,
					args,
					exitCode: result.code,
					truncated,
				},
				isError: result.code !== 0,
			};
		},
	});

	const runCandidate = async (
		label: "A" | "B",
		model: Model<any>,
		context: Context,
		signal?: AbortSignal,
	): Promise<CandidateResult> => {
		const replay = replayPrompt(context.messages);
		if (contextHasImages(context.messages) && !supportsImages(model)) {
			return {
				label,
				modelRef: modelToRef(model)!,
				finalText: "",
				toolSummary: [],
				filesRead: [],
				commandsRun: [],
				assistantMessages: [],
				usage: zeroUsage(),
				skipped: `${formatModelRef(modelToRef(model))} does not support image context`,
			};
		}

		const sessionManager = SessionManager.inMemory(sessionCwd);
		for (const message of replay.history) {
			sessionManager.appendMessage(cloneMessage(message));
		}
		const beforeCount = sessionManager.getEntries().length;
		const { session } = await createAgentSession({
			cwd: sessionCwd,
			model,
			thinkingLevel: model.reasoning ? "high" : "off",
			modelRegistry,
			resourceLoader: makeResourceLoader([context.systemPrompt ?? "", CANDIDATE_SYSTEM_PROMPT].filter(Boolean).join("\n\n")),
			sessionManager,
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
			tools: createReadOnlyTools(sessionCwd),
			customTools: [auditBashTool],
		});

		let abortListener: (() => void) | undefined;
		try {
			if (signal) {
				const abort = () => {
					void session.abort();
				};
				if (signal.aborted) abort();
				signal.addEventListener("abort", abort, { once: true });
				abortListener = () => signal.removeEventListener("abort", abort);
			}
			await session.prompt(replay.promptText, {
				images: replay.promptImages,
				expandPromptTemplates: false,
				source: "extension",
			});
			const newEntries = sessionManager.getEntries().slice(beforeCount);
			const assistantMessages = newEntries
				.filter((entry): entry is typeof entry & { message: AssistantMessage } =>
					entry.type === "message" && entry.message.role === "assistant",
				)
				.map((entry) => entry.message);
			const finalAssistant = assistantMessages.at(-1);
			const { summary, filesRead, commandsRun } = summarizeToolCalls(assistantMessages);
			const usage = zeroUsage();
			for (const message of assistantMessages) addUsage(usage, usageFromAssistant(message));
			return {
				label,
				modelRef: modelToRef(model)!,
				finalText: extractText(finalAssistant?.content),
				toolSummary: summary,
				filesRead,
				commandsRun,
				assistantMessages,
				usage,
				error:
					finalAssistant?.stopReason && finalAssistant.stopReason !== "stop" && finalAssistant.stopReason !== "length"
						? finalAssistant.errorMessage ?? `Candidate finished with ${finalAssistant.stopReason}`
						: undefined,
			};
		} catch (error) {
			return {
				label,
				modelRef: modelToRef(model)!,
				finalText: "",
				toolSummary: [],
				filesRead: [],
				commandsRun: [],
				assistantMessages: [],
				usage: zeroUsage(),
				error: error instanceof Error ? error.message : String(error),
			};
		} finally {
			abortListener?.();
			session.dispose();
		}
	};

	const fuseResults = async (context: Context, candidates: CandidateResult[], signal?: AbortSignal) => {
		const usableCandidates = candidates.filter((candidate) => !candidate.skipped && !candidate.error && candidate.finalText.trim().length > 0);
		if (usableCandidates.length === 0) {
			const fallback = candidates.find((candidate) => candidate.finalText.trim().length > 0);
			if (fallback) return { text: fallback.finalText, usage: fallback.usage };
			throw new Error(candidates.map((candidate) => candidate.error || candidate.skipped || "No output").join("; "));
		}
		if (usableCandidates.length === 1) {
			return { text: usableCandidates[0].finalText, usage: usableCandidates[0].usage };
		}
		const fusionModel = await resolveConfiguredModel(state.fusionModel);
		if (!fusionModel) {
			return { text: usableCandidates[0].finalText, usage: usableCandidates[0].usage };
		}
		if (!modelRegistry) {
			return { text: usableCandidates[0].finalText, usage: usableCandidates[0].usage };
		}
		const auth = await modelRegistry.getApiKeyAndHeaders(fusionModel);
		if (!auth.ok || !auth.apiKey) {
			return { text: usableCandidates[0].finalText, usage: usableCandidates[0].usage };
		}
		const replay = replayPrompt(context.messages);
		const response = await complete(
			fusionModel,
			{
				systemPrompt: FUSION_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: buildFusionPrompt(replay.promptText, usableCandidates) }],
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				signal,
				reasoningEffort: fusionModel.reasoning ? "high" : undefined,
			},
		);
		const text = extractText(response.content);
		if (!text) return { text: usableCandidates[0].finalText, usage: usableCandidates[0].usage };
		return { text, usage: usageFromAssistant(response) };
	};

	const streamFusion = (model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
		const stream = createAssistantMessageEventStream();
		(async () => {
			const output: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: zeroUsage(),
				stopReason: "stop",
				timestamp: Date.now(),
			};
			try {
				stream.push({ type: "start", partial: output });
				if (!state.enabled) throw new Error("Fusion is disabled. Use /fusion on before selecting fusion/audit.");
				const modelA = await resolveConfiguredModel(state.modelA);
				const modelB = await resolveConfiguredModel(state.modelB);
				if (!modelA || !modelB) {
					throw new Error("Fusion is missing one or more candidate models. Re-run /fusion on.");
				}
				setLiveStages({ A: "running", B: "running", Fusor: "idle" });
				const [candidateA, candidateB] = await Promise.all([
					runCandidate("A", modelA, context, options?.signal),
					runCandidate("B", modelB, context, options?.signal),
				]);
				setLiveStages({
					A: candidateA.error ? "error" : "done",
					B: candidateB.error ? "error" : "done",
					Fusor: "running",
				});
				const candidateUsage = zeroUsage();
				addUsage(candidateUsage, candidateA.usage);
				addUsage(candidateUsage, candidateB.usage);
				const fused = await fuseResults(context, [candidateA, candidateB], options?.signal);
				setLiveStages({ Fusor: "done" });
				addUsage(candidateUsage, fused.usage);
				output.usage = candidateUsage;
				const block = { type: "text" as const, text: "" };
				output.content.push(block);
				stream.push({ type: "text_start", contentIndex: 0, partial: output });
				block.text = fused.text;
				stream.push({ type: "text_delta", contentIndex: 0, delta: fused.text, partial: output });
				stream.push({ type: "text_end", contentIndex: 0, content: fused.text, partial: output });
				stream.push({ type: "done", reason: "stop", message: output });
				stream.end();
			} catch (error) {
				setLiveStages({ A: liveStages.A === "running" ? "error" : liveStages.A, B: liveStages.B === "running" ? "error" : liveStages.B, Fusor: liveStages.Fusor === "running" ? "error" : liveStages.Fusor });
				output.stopReason = options?.signal?.aborted ? "aborted" : "error";
				output.errorMessage = error instanceof Error ? error.message : String(error);
				stream.push({ type: "error", reason: output.stopReason, error: output });
				stream.end();
			}
		})();
		return stream;
	};

	pi.registerProvider(FUSION_PROVIDER, {
		baseUrl: "https://fusion.invalid",
		apiKey: "fusion-provider-unused",
		api: "fusion-audit-api",
		models: [
			{
				id: FUSION_MODEL_ID,
				name: "Fusion Audit",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 32_768,
			},
		],
		streamSimple: streamFusion,
	});

	pi.registerCommand("fusion", {
		description: "Toggle fusion audit mode or configure secondary/fusion models",
		handler: async (args, ctx) => {
			modelRegistry = ctx.modelRegistry;
			sessionCwd = ctx.cwd;
			const trimmed = args.trim();
			if (!trimmed) {
				if (state.enabled) await disableFusion(ctx);
				else await enableFusion(ctx);
				return;
			}
			const [command, ...rest] = trimmed.split(/\s+/);
			if (command === "on") {
				await enableFusion(ctx);
				return;
			}
			if (command === "off") {
				await disableFusion(ctx);
				return;
			}
			if (command === "status") {
				if (ctx.hasUI) ctx.ui.notify(formatStatus(), "info");
				return;
			}
			if (command === "secondary") {
				await setConfiguredModel(ctx, "modelB", rest.join(" "), "secondary model");
				return;
			}
			if (command === "fuser") {
				await setConfiguredModel(ctx, "fusionModel", rest.join(" "), "fusion model");
				return;
			}
			if (command === "help" && ctx.hasUI) {
				ctx.ui.notify("/fusion [on|off|status|secondary provider/id|fuser provider/id]", "info");
				return;
			}
			if (ctx.hasUI) ctx.ui.notify("Unknown /fusion command. Use /fusion help", "warning");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		restoreState(ctx);
		liveStatusCtx = ctx;
		if (ctx.model?.provider === FUSION_PROVIDER || branchEndsWithFusionModel(ctx)) {
			restorePrimaryModelAfterStartup();
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreState(ctx);
		liveStatusCtx = ctx;
		if (ctx.model?.provider === FUSION_PROVIDER || branchEndsWithFusionModel(ctx)) {
			restorePrimaryModelAfterStartup();
		}
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		liveStatusCtx = ctx;
		if (!state.enabled) return;
		const fusionModel = modelRegistry?.find(FUSION_PROVIDER, FUSION_MODEL_ID);
		if (!fusionModel) return;
		if (ctx.model?.provider === FUSION_PROVIDER) return;
		switchingModel = true;
		try {
			await pi.setModel(fusionModel);
		} finally {
			switchingModel = false;
		}
	});

	pi.on("agent_start", async (_event, ctx) => {
		liveStatusCtx = ctx;
		if (state.enabled) {
			startLiveStatus(ctx);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		liveStatusCtx = ctx;
		stopLiveStatus();
		if (!state.enabled || ctx.model?.provider !== FUSION_PROVIDER) return;
		const primary = await resolveConfiguredModel(state.modelA);
		if (!primary) return;
		switchingModel = true;
		try {
			await pi.setModel(primary);
		} finally {
			switchingModel = false;
		}
	});

	pi.on("session_shutdown", async () => {
		if (startupRestoreTimer) {
			clearTimeout(startupRestoreTimer);
			startupRestoreTimer = undefined;
		}
		stopLiveStatus();
	});

	pi.on("model_select", async (event, ctx) => {
		modelRegistry = ctx.modelRegistry;
		sessionCwd = ctx.cwd;
		liveStatusCtx = ctx;
		if (switchingModel) return;
		if (!state.enabled && event.model.provider === FUSION_PROVIDER) {
			const primary = await resolveConfiguredModel(state.modelA);
			if (primary) {
				switchingModel = true;
				try {
					await pi.setModel(primary);
				} finally {
					switchingModel = false;
				}
			}
			updateStatus(ctx);
			return;
		}
		if (!state.enabled) {
			updateStatus(ctx);
			return;
		}
		if (event.model.provider === FUSION_PROVIDER) {
			updateStatus(ctx);
			return;
		}
		state.modelA = modelToRef(event.model);
		persistState();
		updateStatus(ctx);
		if (ctx.hasUI) ctx.ui.notify(`Fusion base model updated to ${formatModelRef(state.modelA)}`, "info");
	});
}
