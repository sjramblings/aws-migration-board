/**
 * AWS Migration Board — Multi-Agent Architecture Review System
 *
 * Deliberation engine for AWS migration assessments. Registers 'converse'
 * tool, spawns specialist agent subprocesses (architecture + funding),
 * logs conversations to .jsonl, and renders board member grid in TUI.
 *
 * Usage: pi -e extensions/migration-board.ts
 *   or auto-loaded via .pi/settings.json
 */

import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
	appendFileSync,
} from "node:fs";
import { join, dirname, basename, resolve } from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { BarnesContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

// ── Types ────────────────────────────────────────

interface ExpertiseEntry {
	path: string;
	"use-when": string;
	updatable: boolean;
}

interface SkillEntry {
	path: string;
	"use-when": string;
}

interface AgentDef {
	name: string;
	expertise: ExpertiseEntry[];
	skills: SkillEntry[];
	model: string;
	tools: string[];
	domain: string[];
	systemPrompt: string;
	file: string;
}

interface BoardMemberState {
	def: AgentDef;
	status: "idle" | "responding" | "done" | "error";
	messageCount: number;
	cost: number;
	contextPct: number;
	lastWork: string;
	sessionFile: string | null;
	timer?: ReturnType<typeof setInterval>;
	elapsed: number;
}

interface MeetingConfig {
	meeting: {
		constraints: {
			min_time_minutes: number;
			max_time_minutes: number;
			min_budget: number;
			max_budget: number;
		};
		editor: string;
	};
	brief_sections: string[];
	paths: {
		agents: string;
		briefs: string;
		deliberations: string;
		memos: string;
		expertise: string;
	};
	board: Array<{
		name: string;
		role: string;
		model: string;
	}>;
}

interface ConstraintState {
	elapsed_minutes: number;
	min_time: number;
	max_time: number;
	budget_spent: number;
	min_budget: number;
	max_budget: number;
}

// ── Board Member Colors ─────────────────────────
// Each board member gets a unique hue: bg fills the card interior,
// br is the matching border foreground (brighter shade of same hue).

const BOARD_COLORS: Record<string, { bg: string; br: string }> = {
	// Architecture agents
	"cost-optimizer":        { bg: "\x1b[48;2;25;55;15m",  br: "\x1b[38;2;75;180;45m"   }, // money green
	"reliability-engineer":  { bg: "\x1b[48;2;15;35;75m",  br: "\x1b[38;2;50;120;220m"  }, // blueprint blue
	"security-compliance":   { bg: "\x1b[48;2;75;30;10m",  br: "\x1b[38;2;220;100;30m"  }, // warning amber
	"migration-strategist":  { bg: "\x1b[48;2;20;45;55m",  br: "\x1b[38;2;60;150;170m"  }, // circuit teal
	"modernization-advocate":{ bg: "\x1b[48;2;45;15;75m",  br: "\x1b[38;2;140;55;220m"  }, // cosmic violet
	// Funding agents
	"map-funding":           { bg: "\x1b[48;2;80;55;12m",  br: "\x1b[38;2;215;150;40m"  }, // amber gold
	"partner-incentives":    { bg: "\x1b[48;2;12;50;35m",  br: "\x1b[38;2;40;160;100m"  }, // evergreen
	"edp-commitments":       { bg: "\x1b[48;2;50;22;85m",  br: "\x1b[38;2;145;80;220m"  }, // violet
};
const FG_RESET = "\x1b[39m";
const BG_RESET = "\x1b[49m";
const BOLD = "\x1b[1m";
const BOLD_RESET = "\x1b[22m";

// ── Banner Colors (CEO brand: navy + gold) ──────

function gold(s: string): string {
	return `\x1b[38;2;230;190;60m${s}${FG_RESET}`;
}
function silver(s: string): string {
	return `\x1b[38;2;180;190;210m${s}${FG_RESET}`;
}
function boardColor(name: string, s: string): string {
	const c = BOARD_COLORS[name];
	return c ? `${c.br}${s}${FG_RESET}` : s;
}

// ── YAML Parser (minimal, no deps) ──────────────

function parseYaml(raw: string): any {
	const lines = raw.split("\n");
	const result: any = {};
	const stack: Array<{ obj: any; indent: number }> = [{ obj: result, indent: -1 }];
	let currentArray: any[] | null = null;
	let currentArrayKey = "";
	let currentArrayIndent = -1;

	for (const line of lines) {
		if (line.trim() === "" || line.trim().startsWith("#")) continue;

		const indent = line.search(/\S/);
		const content = line.trim();

		// Array item
		if (content.startsWith("- ")) {
			const value = content.slice(2).trim();

			if (currentArray !== null && indent >= currentArrayIndent) {
				// Check if this is an object item (key: value)
				const kvMatch = value.match(/^(\w[\w-]*)\s*:\s*(.+)$/);
				if (kvMatch) {
					// Object in array
					const obj: any = {};
					obj[kvMatch[1]] = parseYamlValue(kvMatch[2]);
					// Look ahead for more keys at deeper indent
					currentArray.push(obj);
				} else {
					currentArray.push(parseYamlValue(value));
				}
				continue;
			}
		}

		// Key-value pair
		const kvMatch = content.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
		if (kvMatch) {
			const key = kvMatch[1];
			const value = kvMatch[2].trim();

			// Find the right parent
			while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
				stack.pop();
			}
			const parent = stack[stack.length - 1].obj;

			if (value === "" || value === "~") {
				// Could be object or array — peek ahead
				const nextLine = lines[lines.indexOf(line) + 1] || "";
				const nextContent = nextLine.trim();
				if (nextContent.startsWith("- ")) {
					parent[key] = [];
					currentArray = parent[key];
					currentArrayKey = key;
					currentArrayIndent = nextLine.search(/\S/);
				} else {
					parent[key] = {};
					stack.push({ obj: parent[key], indent });
				}
				currentArray = parent[key] instanceof Array ? parent[key] : null;
			} else {
				parent[key] = parseYamlValue(value);
				currentArray = null;
			}
		}
	}

	return result;
}

function parseYamlValue(raw: string): any {
	if (raw === "true") return true;
	if (raw === "false") return false;
	if (raw === "null" || raw === "~") return null;
	if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
	if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw);
	// Strip quotes
	if ((raw.startsWith("'") && raw.endsWith("'")) ||
		(raw.startsWith('"') && raw.endsWith('"'))) {
		return raw.slice(1, -1);
	}
	return raw;
}

// ── Agent Frontmatter Parser ────────────────────

function parseAgentFile(filePath: string): AgentDef | null {
	try {
		const raw = readFileSync(filePath, "utf-8");
		const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
		if (!match) return null;

		const frontmatter = parseYaml(match[1]);
		if (!frontmatter.name) return null;

		// Parse expertise array
		const expertise: ExpertiseEntry[] = [];
		if (Array.isArray(frontmatter.expertise)) {
			// Re-parse expertise from raw frontmatter for complex nested objects
			const expertiseRaw = match[1];
			const expertiseBlocks = expertiseRaw.split(/\n\s+-\s+path:/);
			for (let i = 1; i < expertiseBlocks.length; i++) {
				const block = "path:" + expertiseBlocks[i];
				const pathMatch = block.match(/path:\s*(.+)/);
				const useWhenMatch = block.match(/use-when:\s*"([^"]+)"/);
				const updatableMatch = block.match(/updatable:\s*(true|false)/);
				if (pathMatch) {
					expertise.push({
						path: pathMatch[1].trim(),
						"use-when": useWhenMatch ? useWhenMatch[1] : "",
						updatable: updatableMatch ? updatableMatch[1] === "true" : false,
					});
				}
			}
		}

		// Parse skills array
		const skills: SkillEntry[] = [];
		if (Array.isArray(frontmatter.skills)) {
			const skillsRaw = match[1];
			const skillsBlocks = skillsRaw.split(/\n\s+-\s+path:/).filter((_: string, i: number) => {
				// Only take blocks after "skills:" appears
				return true;
			});
			// Simple approach: scan for skill entries after "skills:" in raw
			const skillsSection = skillsRaw.split("skills:")[1] || "";
			const skillEntries = skillsSection.split(/\n\s+-\s+path:/);
			for (let i = 1; i < skillEntries.length; i++) {
				const block = "path:" + skillEntries[i];
				const pathMatch = block.match(/path:\s*(.+)/);
				const useWhenMatch = block.match(/use-when:\s*"([^"]+)"/);
				if (pathMatch) {
					skills.push({
						path: pathMatch[1].trim(),
						"use-when": useWhenMatch ? useWhenMatch[1] : "",
					});
				}
			}
		}

		return {
			name: frontmatter.name,
			expertise,
			skills,
			model: frontmatter.model || "openai/gpt-5.4",
			tools: typeof frontmatter.tools === "string"
				? frontmatter.tools.split(",").map((t: string) => t.trim()).filter(Boolean)
				: [],
			domain: Array.isArray(frontmatter.domain) ? frontmatter.domain : [],
			systemPrompt: match[2].trim(),
			file: filePath,
		};
	} catch {
		return null;
	}
}

// ── Config Loader ───────────────────────────────

function loadConfig(cwd: string): MeetingConfig {
	const configPath = join(cwd, "migration-board-configuration.yaml");
	if (!existsSync(configPath)) {
		throw new Error(`Config not found: ${configPath}`);
	}
	const raw = readFileSync(configPath, "utf-8");

	// Parse the YAML more carefully for the nested structure
	const config: MeetingConfig = {
		meeting: {
			constraints: { min_time_minutes: 2, max_time_minutes: 5, min_budget: 1, max_budget: 5 },
			editor: "code",
		},
		brief_sections: ["situation", "stakes", "constraints", "key question"],
		paths: {
			agents: ".pi/ceo-agents/agents",
			briefs: ".pi/ceo-agents/briefs",
			deliberations: ".pi/ceo-agents/deliberations",
			memos: ".pi/ceo-agents/memos",
			expertise: ".pi/ceo-agents/expertise",
		},
		board: [],
	};

	// Parse constraints
	const minTimeMatch = raw.match(/min_time_minutes:\s*(\d+)/);
	const maxTimeMatch = raw.match(/max_time_minutes:\s*(\d+)/);
	const minBudgetMatch = raw.match(/min_budget:\s*(\d+)/);
	const maxBudgetMatch = raw.match(/max_budget:\s*(\d+)/);
	if (minTimeMatch) config.meeting.constraints.min_time_minutes = parseInt(minTimeMatch[1]);
	if (maxTimeMatch) config.meeting.constraints.max_time_minutes = parseInt(maxTimeMatch[1]);
	if (minBudgetMatch) config.meeting.constraints.min_budget = parseInt(minBudgetMatch[1]);
	if (maxBudgetMatch) config.meeting.constraints.max_budget = parseInt(maxBudgetMatch[1]);

	const editorMatch = raw.match(/editor:\s*'?([^'\n]+)'?/);
	if (editorMatch) config.meeting.editor = editorMatch[1].trim();

	// Parse brief_sections
	const sectionsMatch = raw.match(/brief_sections:\s*\n((?:\s+-\s+.+\n?)+)/);
	if (sectionsMatch) {
		config.brief_sections = sectionsMatch[1]
			.split("\n")
			.map(l => l.replace(/^\s+-\s+/, "").trim())
			.filter(Boolean);
	}

	// Parse paths
	const pathKeys = ["agents", "briefs", "deliberations", "memos", "expertise"];
	for (const key of pathKeys) {
		const pathMatch = raw.match(new RegExp(`${key}:\\s*(.+)`));
		if (pathMatch) {
			(config.paths as any)[key] = pathMatch[1].trim();
		}
	}

	// Parse board
	const boardSection = raw.split("board:")[1] || "";
	const boardEntries = boardSection.split(/\n\s+-\s+name:/);
	for (let i = 1; i < boardEntries.length; i++) {
		const entry = boardEntries[i];
		const nameVal = entry.split("\n")[0].trim();
		const roleMatch = entry.match(/role:\s*(.+)/);
		const modelMatch = entry.match(/model:\s*(.+)/);
		config.board.push({
			name: nameVal,
			role: roleMatch ? roleMatch[1].trim() : nameVal,
			model: modelMatch ? modelMatch[1].trim() : "openai/gpt-5.4",
		});
	}

	return config;
}

// ── Brief Helpers ───────────────────────────────

function listBriefs(briefsDir: string): string[] {
	if (!existsSync(briefsDir)) return [];
	return readdirSync(briefsDir)
		.filter(f => {
			const fullPath = join(briefsDir, f);
			try {
				return existsSync(join(fullPath, "brief.md"));
			} catch { return false; }
		})
		.sort()
		.reverse();
}

function validateBrief(content: string, requiredSections: string[]): string[] {
	const missing: string[] = [];
	const lower = content.toLowerCase();
	for (const section of requiredSections) {
		const pattern = `## ${section.toLowerCase()}`;
		if (!lower.includes(pattern)) {
			missing.push(section);
		}
	}
	return missing;
}

// ── Session ID Generator ────────────────────────

function generateSessionId(): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	let id = "";
	for (let i = 0; i < 7; i++) {
		id += chars[Math.floor(Math.random() * chars.length)];
	}
	return id;
}

// ── Expertise Block Builder ─────────────────────

function buildExpertiseBlock(agent: AgentDef, cwd: string): string {
	if (agent.expertise.length === 0) return "_No expertise files configured._";

	const lines: string[] = [];
	for (const exp of agent.expertise) {
		const fullPath = join(cwd, exp.path);
		const exists = existsSync(fullPath);
		lines.push(`**File:** \`${exp.path}\``);
		lines.push(`**Use when:** ${exp["use-when"]}`);
		lines.push(`**Updatable:** ${exp.updatable ? "Yes — write freely" : "Read-only"}`);
		if (exists) {
			const content = readFileSync(fullPath, "utf-8");
			lines.push(`\n\`\`\`markdown\n${content}\n\`\`\`\n`);
		} else {
			lines.push(`_(File not found: ${fullPath})_\n`);
		}
	}
	return lines.join("\n");
}

function buildSkillsBlock(agent: AgentDef, cwd: string): string {
	if (agent.skills.length === 0) return "_No skills configured._";

	const lines: string[] = [];
	for (const skill of agent.skills) {
		const fullPath = join(cwd, skill.path);
		const exists = existsSync(fullPath);
		lines.push(`**Skill:** \`${skill.path}\``);
		lines.push(`**Use when:** ${skill["use-when"]}`);
		if (exists) {
			const content = readFileSync(fullPath, "utf-8");
			lines.push(`\n\`\`\`markdown\n${content}\n\`\`\`\n`);
		}
	}
	return lines.join("\n");
}

// ── System Prompt Builder ───────────────────────

function buildSystemPrompt(
	agent: AgentDef,
	cwd: string,
	vars: Record<string, string>,
): string {
	let prompt = agent.systemPrompt;

	// Inject expertise block
	prompt = prompt.replace("{{EXPERTISE_BLOCK}}", buildExpertiseBlock(agent, cwd));

	// Inject skills block
	prompt = prompt.replace("{{SKILLS_BLOCK}}", buildSkillsBlock(agent, cwd));

	// Inject runtime variables
	for (const [key, value] of Object.entries(vars)) {
		prompt = prompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
	}

	return prompt;
}

// ── Display Helpers ─────────────────────────────

function displayName(name: string): string {
	return name.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// ── Extension ───────────────────────────────────

export default function (pi: ExtensionAPI) {
	let config: MeetingConfig;
	let cwd = "";
	let agentDefs: Map<string, AgentDef> = new Map();
	let boardStates: Map<string, BoardMemberState> = new Map();
	let widgetCtx: any;
	let sessionDir = "";

	// Meeting state
	let meetingActive = false;
	let sessionId = "";
	let briefContent = "";
	let briefName = "";
	let deliberationDir = "";
	let conversationLogPath = "";
	let toolUseLogPath = "";
	let memoDir = "";
	let memoPath = "";
	let meetingStartTime = 0;
	let totalCost = 0;
	let roundCount = 0;
	let meetingComplete = false;
	let finalElapsedMinutes = 0;

	// ── Load Everything ─────────────────────────

	function loadAll(workingDir: string) {
		cwd = workingDir;
		config = loadConfig(cwd);
		sessionDir = join(cwd, ".pi", "agent-sessions");
		if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });

		// Load agent definitions
		agentDefs.clear();
		boardStates.clear();

		const agentsDir = join(cwd, config.paths.agents);
		if (existsSync(agentsDir)) {
			for (const file of readdirSync(agentsDir)) {
				if (!file.endsWith(".md")) continue;
				const def = parseAgentFile(join(agentsDir, file));
				if (def) {
					agentDefs.set(def.name.toLowerCase(), def);
				}
			}
		}

		// Initialize board member states (exclude CEO)
		for (const member of config.board) {
			if (member.name.toLowerCase() === "solution-architect") continue;
			const def = agentDefs.get(member.name.toLowerCase());
			if (!def) continue;
			const key = def.name.toLowerCase();
			const agentSessionFile = join(sessionDir, `${key}.json`);
			boardStates.set(key, {
				def,
				status: "idle",
				messageCount: 0,
				cost: 0,
				contextPct: 0,
				lastWork: "",
				sessionFile: existsSync(agentSessionFile) ? agentSessionFile : null,
				elapsed: 0,
			});
		}
	}

	// ── Conversation Log ────────────────────────

	function logConversation(entry: Record<string, any>) {
		if (!conversationLogPath) return;
		appendFileSync(conversationLogPath, JSON.stringify(entry) + "\n");
	}

	function logToolUse(entry: Record<string, any>) {
		if (!toolUseLogPath) return;
		appendFileSync(toolUseLogPath, JSON.stringify(entry) + "\n");
	}

	// ── Get Constraint State ────────────────────

	function getConstraintState(): ConstraintState {
		// Freeze elapsed time once meeting is complete
		const elapsed = meetingComplete
			? finalElapsedMinutes
			: (Date.now() - meetingStartTime) / 60000;
		return {
			elapsed_minutes: Math.round(elapsed * 10) / 10,
			min_time: config.meeting.constraints.min_time_minutes,
			max_time: config.meeting.constraints.max_time_minutes,
			budget_spent: Math.round(totalCost * 100) / 100,
			min_budget: config.meeting.constraints.min_budget,
			max_budget: config.meeting.constraints.max_budget,
		};
	}

	function formatConstraints(cs: ConstraintState): string {
		return [
			`\n---`,
			`**Constraints:**`,
			`TIME: ${cs.elapsed_minutes} min elapsed | range: ${cs.min_time}–${cs.max_time} min`,
			`BUDGET: $${cs.budget_spent} spent | range: $${cs.min_budget}–$${cs.max_budget}`,
			cs.elapsed_minutes >= cs.max_time * 0.8
				? `⚠️ TIME approaching maximum — begin convergence`
				: "",
			cs.budget_spent >= cs.max_budget * 0.8
				? `⚠️ BUDGET approaching maximum — begin convergence`
				: "",
		].filter(Boolean).join("\n");
	}

	// ── Send Message to Board Member ────────────

	function sendToBoardMember(
		memberName: string,
		message: string,
		conversationContext: string,
		ctx: any,
	): Promise<{ output: string; cost: number; elapsed: number }> {
		const key = memberName.toLowerCase();
		const state = boardStates.get(key);
		if (!state) {
			return Promise.resolve({
				output: `Board member "${memberName}" not found.`,
				cost: 0,
				elapsed: 0,
			});
		}

		state.status = "responding";
		state.messageCount++;
		const startTime = Date.now();
		state.timer = setInterval(() => {
			state.elapsed = Date.now() - startTime;
			updateWidget();
		}, 1000);
		updateWidget();

		// Build system prompt with runtime vars
		const vars: Record<string, string> = {
			SESSION_ID: sessionId,
			BRIEF_CONTENT: briefContent,
			BOARD_MEMBERS: Array.from(boardStates.keys()).map(displayName).join(", "),
		};
		const systemPrompt = buildSystemPrompt(state.def, cwd, vars);

		// Build the task: conversation context + new message
		// Note: the brief is already in the system prompt via {{BRIEF_CONTENT}} — don't duplicate it
		const taskParts = [
			`Session: ${sessionId}. You are in a board deliberation.`,
			``,
			`## CEO's Message`,
			message,
		];

		// Only include conversation context if there is any
		if (conversationContext.trim()) {
			taskParts.push(``);
			taskParts.push(`## Prior Conversation`);
			taskParts.push(conversationContext);
		}

		taskParts.push(``);
		taskParts.push(`## Your Instructions (follow this exact order)`);
		taskParts.push(`1. Read your scratch pad file to review your prior notes.`);
		taskParts.push(`2. Write your updated scratch pad IMMEDIATELY — add new observations, positions taken, tensions with other members, and facts that matter from this round. Do this BEFORE your response text.`);
		taskParts.push(`3. THEN respond with your position, analysis, and reasoning. Be concise but thorough.`);
		taskParts.push(``);
		taskParts.push(`⚠️ You MUST complete steps 1 and 2 (read + write scratch pad) BEFORE generating your response text. If you respond first, you may not get a chance to write.`);

		// Add explicit scratch pad paths so the agent knows exactly where to read/write
		const scratchPads = state.def.expertise.filter(e => e.updatable);
		if (scratchPads.length > 0) {
			taskParts.push(``);
			taskParts.push(`## Your Scratch Pad Files`);
			for (const sp of scratchPads) {
				const fullPath = join(cwd, sp.path);
				taskParts.push(`- READ then WRITE: ${fullPath}`);
			}
		}

		// Path restrictions — only access allowed locations
		const allowedPaths = state.def.expertise.map(e => join(cwd, e.path));
		taskParts.push(``);
		taskParts.push(`## Path Restrictions`);
		taskParts.push(`You may ONLY read and write these files:`);
		for (const p of allowedPaths) {
			taskParts.push(`- ${p}`);
		}
		taskParts.push(`Do NOT access any other files. Do NOT run find, ls, or explore the filesystem.`);

		const task = taskParts.join("\n");

		const agentKey = state.def.name.toLowerCase().replace(/\s+/g, "-");
		const agentSessionFile = join(sessionDir, `${agentKey}.json`);

		// Don't pass --model — let subprocesses inherit Pi's default model+auth.
		// Passing an explicit model like "openai/gpt-5.4" requires a separate
		// API key for that provider. Omitting it uses whichever provider Pi
		// authenticated with (e.g. openai-codex via OAuth).
		const args = [
			"--mode", "json",
			"-p",
			"--no-extensions",
			"--thinking", "off",
			"--append-system-prompt", systemPrompt,
			"--session", agentSessionFile,
		];

		// Restrict board member tools from frontmatter
		if (state.def.tools.length > 0) {
			args.push("--tools", state.def.tools.join(","));
		}

		if (state.sessionFile) {
			args.push("-c");
		}

		args.push(task);

		const textChunks: string[] = [];
		const stderrChunks: string[] = [];

		return new Promise((resolve) => {
			const proc = spawn("pi", args, {
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env },
			});

			let buffer = "";

			proc.stdout!.setEncoding("utf-8");
			proc.stdout!.on("data", (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const event = JSON.parse(line);
						if (event.type === "message_update") {
							const delta = event.assistantMessageEvent;
							if (delta?.type === "text_delta") {
								textChunks.push(delta.delta || "");
								const full = textChunks.join("");
								const last = full.split("\n").filter((l: string) => l.trim()).pop() || "";
								state.lastWork = last;
								updateWidget();
							}
						} else if (event.type === "tool_execution_start") {
							logToolUse({
								timestamp: new Date().toISOString(),
								agent: memberName,
								tool_name: event.toolName || "unknown",
								tool_call_id: event.toolCallId || "",
								args: event.args || {},
							});
						} else if (event.type === "message_end") {
							const msg = event.message;
							if (msg?.usage) {
								const inputTokens = msg.usage.input || 0;
								const outputTokens = msg.usage.output || 0;
								const msgCost = (inputTokens * 0.00001) + (outputTokens * 0.00004);
								state.cost += msgCost;
								totalCost += msgCost;
								state.contextPct = Math.min(100, (inputTokens / 128000) * 100);
								updateWidget();
							}
						}
					} catch {}
				}
			});

			proc.stderr!.setEncoding("utf-8");
			proc.stderr!.on("data", (chunk: string) => {
				stderrChunks.push(chunk);
			});

			proc.on("close", (code) => {
				if (buffer.trim()) {
					try {
						const event = JSON.parse(buffer);
						if (event.type === "message_update") {
							const delta = event.assistantMessageEvent;
							if (delta?.type === "text_delta") textChunks.push(delta.delta || "");
						}
					} catch {}
				}

				clearInterval(state.timer);
				state.elapsed = Date.now() - startTime;
				state.status = code === 0 ? "done" : "error";
				state.sessionFile = agentSessionFile;
				updateWidget();

				const full = textChunks.join("");
				const stderr = stderrChunks.join("");
				state.lastWork = full.split("\n").filter((l: string) => l.trim()).pop() || "";

				// If no output, surface stderr for debugging
				let output = full;
				if (!output.trim() && stderr.trim()) {
					output = `[Agent error — stderr output]\n${stderr.slice(0, 2000)}`;
				} else if (!output.trim()) {
					output = `[No response from ${displayName(memberName)}. Exit code: ${code}]`;
				}

				resolve({
					output,
					cost: state.cost,
					elapsed: state.elapsed,
				});
			});

			proc.on("error", (err) => {
				clearInterval(state.timer);
				state.status = "error";
				state.lastWork = `Error: ${err.message}`;
				updateWidget();
				resolve({
					output: `[Spawn error: ${err.message}]`,
					cost: 0,
					elapsed: Date.now() - startTime,
				});
			});
		});
	}

	// ── Board Widget ────────────────────────────

	function renderBoardCard(state: BoardMemberState, colWidth: number, theme: any): string[] {
		const w = colWidth - 2;
		const truncate = (s: string, max: number) => s.length > max ? s.slice(0, max - 3) + "..." : s;

		const statusColor = state.status === "idle" ? "dim"
			: state.status === "responding" ? "accent"
			: state.status === "done" ? "success" : "error";
		const statusIcon = state.status === "idle" ? "○"
			: state.status === "responding" ? "●"
			: state.status === "done" ? "✓" : "✗";

		const name = displayName(state.def.name);
		const nameStr = theme.fg("accent", theme.bold(truncate(name, w - 4)));
		const nameVisible = Math.min(name.length, w - 4);

		const msgStr = `${statusIcon} ${state.messageCount}`;
		const costStr = `$${state.cost.toFixed(2)}`;
		const timeStr = state.elapsed > 0 ? ` ${Math.round(state.elapsed / 1000)}s` : "";
		const statusLine = theme.fg(statusColor, `${msgStr}  ${costStr}${timeStr}`);
		const statusVisible = msgStr.length + 2 + costStr.length + timeStr.length;

		// 10-block context meter with color-coded fill
		const filled = Math.round(state.contextPct / 10);
		const ctxBar =
			theme.fg("warning", "[") +
			theme.fg("success", "#".repeat(filled)) +
			theme.fg("dim", "-".repeat(10 - filled)) +
			theme.fg("warning", "]") +
			theme.fg("dim", " ") +
			theme.fg("accent", `${Math.ceil(state.contextPct)}%`);
		const ctxVisible = 1 + filled + (10 - filled) + 1 + 1 + `${Math.ceil(state.contextPct)}%`.length;

		const workRaw = state.lastWork || state.def.name;
		const workText = truncate(workRaw, Math.min(50, w - 1));
		const workLine = theme.fg("muted", workText);
		const workVisible = workText.length;

		// Colored background + border (per-agent personality)
		const colors = BOARD_COLORS[state.def.name];
		const bg  = colors?.bg ?? "";
		const br  = colors?.br ?? "";
		const bgr = bg ? BG_RESET : "";
		const fgr = br ? FG_RESET : "";
		const bord = (s: string) => bg + br + s + bgr + fgr;

		const top = "┌" + "─".repeat(w) + "┐";
		const bot = "└" + "─".repeat(w) + "┘";
		const border = (content: string, visLen: number) => {
			const pad = " ".repeat(Math.max(0, w - visLen));
			return bord("│") + bg + content + bg + pad + bgr + bord("│");
		};

		return [
			bord(top),
			border(" " + nameStr, 1 + nameVisible),
			border(" " + statusLine, 1 + statusVisible),
			border(" " + ctxBar, 1 + ctxVisible),
			border(" " + workLine, 1 + workVisible),
			bord(bot),
		];
	}

	function updateWidget() {
		if (!widgetCtx) return;

		widgetCtx.ui.setWidget("ceo-board", (_tui: any, theme: any) => {
			const text = new Text("", 0, 1);

			return {
				render(width: number): string[] {
					if (boardStates.size === 0) {
						text.setText(theme.fg("dim", "No board members loaded."));
						return text.render(width);
					}

					const cols = Math.min(3, boardStates.size);
					const gap = 1;
					const colWidth = Math.floor((width - gap * (cols - 1)) / cols);
					const agents = Array.from(boardStates.values());
					const rows: string[][] = [];

					// Widget header + gradient constraint bars
					if (meetingActive) {
						const cs = getConstraintState();
						const phase = meetingComplete ? "complete" : cs.elapsed_minutes >= cs.max_time * 0.8 ? "converging" : "deliberating";
						const phaseColor = phase === "complete" ? "success" : phase === "converging" ? "warning" : "muted";

						// Header: Session · Round · Phase
						const headerLine =
							theme.fg("dim", "  Session: ") +
							theme.fg("accent", sessionId) +
							theme.fg("dim", "  ·  ") +
							theme.fg("warning", `Round ${roundCount}`) +
							theme.fg("dim", "  ·  ") +
							theme.fg(phaseColor, phase);
						rows.push([headerLine]);
						rows.push([""]);

						// Gradient bar helper
						const gradientBar = (pct: number, segments: number) => {
							const filled = Math.floor(pct * segments);
							let bar = "";
							for (let i = 0; i < segments; i++) {
								if (i >= filled) {
									bar += theme.fg("dim", "░");
								} else {
									const pos = i / segments;
									if (pos >= 0.8) bar += theme.fg("error", "█");
									else if (pos >= 0.5) bar += theme.fg("warning", "█");
									else bar += theme.fg("success", "█");
								}
							}
							return bar;
						};

						const barLen = Math.floor(width * 0.35);
						const timePct = Math.min(1, cs.elapsed_minutes / cs.max_time);
						const budgetPct = Math.min(1, cs.budget_spent / cs.max_budget);

						const constraintLine =
							theme.fg("dim", "  TIME   ") +
							gradientBar(timePct, barLen) +
							theme.fg("dim", "  ") +
							theme.fg("accent", `${cs.elapsed_minutes} min`) +
							theme.fg("dim", ` (${Math.round(timePct * 100)}%)  ${cs.min_time}-${cs.max_time} min`);

						const budgetLine =
							theme.fg("dim", "  BUDGET ") +
							gradientBar(budgetPct, barLen) +
							theme.fg("dim", "  ") +
							theme.fg("accent", `$${cs.budget_spent}`) +
							theme.fg("dim", ` (${Math.round(budgetPct * 100)}%)  $${cs.min_budget}-$${cs.max_budget}`);

						rows.push([constraintLine]);
						rows.push([budgetLine]);
						rows.push([""]);
					}

					for (let i = 0; i < agents.length; i += cols) {
						const rowAgents = agents.slice(i, i + cols);
						const cards = rowAgents.map(a => renderBoardCard(a, colWidth, theme));

						while (cards.length < cols) {
							cards.push(Array(6).fill(" ".repeat(colWidth)));
						}

						const cardHeight = cards[0].length;
						for (let line = 0; line < cardHeight; line++) {
							rows.push(cards.map(card => card[line] || ""));
						}
					}

					const output = rows.map(cols => cols.join(" ".repeat(gap)));
					text.setText(output.join("\n"));
					return text.render(width);
				},
				invalidate() {
					text.invalidate();
				},
			};
		});
	}

	// ── Conversation Context Builder ────────────

	function getConversationContext(): string {
		if (!conversationLogPath || !existsSync(conversationLogPath)) return "";
		const raw = readFileSync(conversationLogPath, "utf-8");
		const lines = raw.split("\n").filter(Boolean);
		const messages: string[] = [];
		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.type === "message") {
					messages.push(`**${displayName(entry.from)}** → ${entry.to}: ${entry.message}`);
				}
			} catch {}
		}
		return messages.join("\n\n");
	}

	// ── Register Tools ──────────────────────────

	// converse tool — CEO's primary interaction tool
	pi.registerTool({
		name: "converse",
		label: "Converse with Board",
		description: [
			"Send a message to board members. Use this for every board interaction.",
			"- `to`: a board member name, an array of names, or \"all\"",
			"- `message`: your question, challenge, follow-up, or directive",
			"Returns: responses from addressed members + constraint state",
		].join("\n"),
		parameters: Type.Object({
			to: Type.Union([
				Type.String({ description: 'Board member name, or "all"' }),
				Type.Array(Type.String(), { description: "Array of board member names" }),
			]),
			message: Type.String({ description: "Your message to the board member(s)" }),
		}),

		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			if (!meetingActive) {
				return {
					content: [{ type: "text", text: "No active deliberation. Use /migrate-begin to start." }],
				};
			}

			const { to, message } = params as { to: string | string[]; message: string };

			// Resolve target members — normalize spaces/hyphens/case
			function resolveTarget(raw: string): string {
				const normalized = raw.toLowerCase().replace(/\s+/g, "-");
				if (boardStates.has(normalized)) return normalized;
				// Try without hyphens (match "technical architect" to "technical-architect")
				for (const key of boardStates.keys()) {
					if (key === normalized) return key;
					if (key.replace(/-/g, " ") === raw.toLowerCase()) return key;
					// Fuzzy: check if display name matches
					if (displayName(key).toLowerCase() === raw.toLowerCase()) return key;
				}
				return normalized;
			}

			let targets: string[];
			if (to === "all") {
				targets = Array.from(boardStates.keys());
			} else if (Array.isArray(to)) {
				targets = to.map(resolveTarget);
			} else {
				targets = [resolveTarget(to)];
			}

			// Validate targets
			const invalid = targets.filter(t => !boardStates.has(t));
			if (invalid.length > 0) {
				return {
					content: [{ type: "text", text: `Unknown board members: ${invalid.join(", ")}. Available: ${Array.from(boardStates.keys()).map(displayName).join(", ")}` }],
				};
			}

			// Log CEO's message
			logConversation({
				type: "message",
				from: "CEO",
				to: to === "all" ? "all" : targets.map(displayName).join(", "),
				message,
				timestamp: new Date().toISOString(),
				session_id: sessionId,
			});

			roundCount++;

			// Run all targeted board members IN PARALLEL.
			// Each member receives the existing conversation context (prior rounds)
			// but NOT other members' responses from THIS round — they respond
			// independently. After all respond, the full round output is collated
			// and appended to the conversation log so the NEXT round has everything.
			const conversationContext = getConversationContext();

			if (onUpdate) {
				const names = targets.map(displayName).join(", ");
				onUpdate({
					content: [{ type: "text", text: `${names} responding...` }],
					details: { targets: targets.map(displayName), status: "responding" },
				});
			}

			// Launch all board members simultaneously
			const parallelResults = await Promise.all(
				targets.map(async (target) => {
					const state = boardStates.get(target);
					if (!state) return { target, output: `[${target} not found]`, cost: 0, elapsed: 0 };

					const result = await sendToBoardMember(target, message, conversationContext, ctx);
					return { target, ...result };
				})
			);

			// Collate responses and log each one
			const responses: string[] = [];
			for (const result of parallelResults) {
				const name = displayName(result.target);
				const responseEntry = `**${name}:**\n${result.output}`;
				responses.push(responseEntry);

				logConversation({
					type: "message",
					from: name,
					to: "all",
					message: result.output,
					timestamp: new Date().toISOString(),
					session_id: sessionId,
				});

				// Reset status to idle for next round
				const state = boardStates.get(result.target);
				if (state) {
					state.status = "idle";
				}
			}
			updateWidget();

			// Check constraints
			const cs = getConstraintState();
			const constraintText = formatConstraints(cs);

			// Check if max constraints hit
			const maxTimeHit = cs.elapsed_minutes >= cs.max_time;
			const maxBudgetHit = cs.budget_spent >= cs.max_budget;
			let constraintWarning = "";
			if (maxTimeHit || maxBudgetHit) {
				constraintWarning = "\n\n🛑 **CONSTRAINT REACHED** — You must now ask for final positions and write the memo.";
				const reason = maxTimeHit ? "max_time_constraint" : "max_budget_constraint";
				logConversation({
					type: "constraint_warning",
					reason,
					timestamp: new Date().toISOString(),
					session_id: sessionId,
					...cs,
				});
			}

			const fullResponse = responses.join("\n\n---\n\n") + constraintText + constraintWarning;

			return {
				content: [{ type: "text", text: fullResponse }],
				details: {
					constraint_state: cs,
					members_responded: targets.map(displayName),
				},
			};
		},
	});

	// ── Session Events ──────────────────────────

	pi.on("session_start", async (_event: any, ctx: any) => {
		widgetCtx = ctx;
		const workDir = ctx.cwd || process.cwd();
		loadAll(workDir);

		// Restrict orchestrator to tools declared in its frontmatter
		// Prevents noisy filesystem exploration (bash, find, ls, grep) in the conversation
		const saDefForTools = agentDefs.get("solution-architect");
		if (saDefForTools && saDefForTools.tools.length > 0) {
			pi.setActiveTools(saDefForTools.tools);
		}

		// Set up custom footer
		setupFooter(ctx);

		// Display styled boot banner
		const saDef = agentDefs.get("solution-architect");
		const saModel = saDef?.model || "openai/gpt-5.4";
		const memberList = Array.from(boardStates.entries()).map(([key, state]) => {
			const coloredName = boardColor(key, `◆ ${displayName(state.def.name)}`);
			return `  ${coloredName}`;
		});

		ctx.ui.notify([
			gold(`${BOLD}AWS MIGRATION BOARD${BOLD_RESET} — Architecture Review System`),
			"",
			silver(`Time     ${config.meeting.constraints.min_time_minutes}-${config.meeting.constraints.max_time_minutes} min`),
			silver(`Budget   $${config.meeting.constraints.min_budget}-$${config.meeting.constraints.max_budget}`),
			silver(`Editor   ${config.meeting.editor}`),
			"",
			gold("Board"),
			`  ${gold("◆ Solution Architect")}`,
			...memberList,
			"",
			silver("Run /migrate-begin to start an assessment."),
		].join("\n"), "info");

		updateWidget();
	});

	// ── Path Access Enforcement (CEO agent) ──────
	// Enforces that the orchestrator can only read/write/edit files within allowed paths:
	// - Its own expertise files (from frontmatter)
	// - The active deliberation directory
	// - The active memo directory

	pi.on("tool_call", async (event: any, ctx: any) => {
		const toolName = event.toolName || event.type || "";

		// Only enforce on file-access tools
		if (!["read", "write", "edit"].includes(toolName)) return { block: false };

		const targetPath = event.input?.path;
		if (!targetPath) return { block: false };

		const resolvedTarget = resolve(ctx.cwd, targetPath);

		// Detect memo write — finalize the meeting
		if (meetingActive && !meetingComplete && (toolName === "write" || toolName === "edit")) {
			if (memoPath && (resolvedTarget === memoPath || resolvedTarget.endsWith("/memo.md") || resolvedTarget.endsWith("/proposal.html"))) {
				meetingComplete = true;
				finalElapsedMinutes = (Date.now() - meetingStartTime) / 60000;

				logConversation({
					type: "meeting_end",
					session_id: sessionId,
					timestamp: new Date().toISOString(),
					elapsed_minutes: Math.round(finalElapsedMinutes * 10) / 10,
					total_cost: Math.round(totalCost * 100) / 100,
					end_reason: "memo_written",
				});

				updateWidget();
			}
		}

		// Build allowlist from orchestrator expertise + active session paths
		const allowedPrefixes: string[] = [];

		// Orchestrator expertise files
		const saDef = agentDefs.get("solution-architect");
		if (saDef) {
			for (const exp of saDef.expertise) {
				allowedPrefixes.push(resolve(cwd, exp.path));
			}
		}

		// Active deliberation + memo directories (if meeting is running)
		if (meetingActive) {
			if (deliberationDir) allowedPrefixes.push(deliberationDir);
			if (memoDir) allowedPrefixes.push(memoDir);
			if (memoPath) allowedPrefixes.push(memoPath);
		}

		// Expertise directory (read-only access for reviewing other scratch pads)
		const expertiseDir = resolve(cwd, config.paths.expertise);
		allowedPrefixes.push(expertiseDir);

		// Brief directory (read-only)
		const briefsDir = resolve(cwd, config.paths.briefs);
		allowedPrefixes.push(briefsDir);

		// Check if target falls within any allowed prefix
		const allowed = allowedPrefixes.some(prefix =>
			resolvedTarget === prefix || resolvedTarget.startsWith(prefix + "/") || resolvedTarget.startsWith(prefix)
		);

		if (!allowed) {
			return {
				block: true,
				reason: `🛡️ Path restricted: ${targetPath} is outside allowed locations (expertise, briefs, deliberations, memos). Focus on the deliberation — use converse() to engage the board.`,
			};
		}

		return { block: false };
	});

	// ── System Prompt Injection ──────────────────

	pi.on("before_agent_start", async (_event: any, _ctx: any) => {
		if (!meetingActive) {
			// Default system prompt when no meeting is active
			const saDef = agentDefs.get("solution-architect");
			const boardList = Array.from(boardStates.entries())
				.map(([, state]) => `  - ${displayName(state.def.name)}`)
				.join("\n");

			return {
				systemPrompt: [
					"# AWS Migration Board — Architecture Review System",
					"",
					"You are the Solution Architect leading an AWS migration review board.",
					"",
					"**Warning: This agent only runs deliberations.**",
					"Use /migrate-begin to start a meeting.",
					"",
					"Board Members:",
					boardList,
				].join("\n"),
			};
		}

		// Build orchestrator system prompt with runtime vars
		const saDef = agentDefs.get("solution-architect");
		if (!saDef) return {};

		const vars: Record<string, string> = {
			SESSION_ID: sessionId,
			BRIEF_CONTENT: briefContent,
			BOARD_MEMBERS: Array.from(boardStates.keys()).map(displayName).join(", "),
			MEMO_PATH: memoPath,
			MIN_TIME: String(config.meeting.constraints.min_time_minutes),
			MAX_TIME: String(config.meeting.constraints.max_time_minutes),
			MIN_BUDGET: String(config.meeting.constraints.min_budget),
			MAX_BUDGET: String(config.meeting.constraints.max_budget),
		};

		return { systemPrompt: buildSystemPrompt(saDef, cwd, vars) };
	});

	// ── /migrate-begin Command ──────────────────────

	pi.registerCommand("migrate-begin", {
		description: "Start a board deliberation",
		handler: async (args: string, ctx: any) => {
			if (meetingActive) {
				ctx.ui.notify("A deliberation is already in progress.", "error");
				return;
			}

			const briefsDir = join(cwd, config.paths.briefs);
			const briefs = listBriefs(briefsDir);

			if (briefs.length === 0) {
				ctx.ui.notify(
					`No briefs found in ${config.paths.briefs}/. Create a brief using the template.`,
					"error"
				);
				return;
			}

			// Show brief selection dialog
			let selectedBrief: string;
			if (args && args.trim()) {
				// Direct selection via argument
				const match = briefs.find(b =>
					b.toLowerCase().includes(args.trim().toLowerCase())
				);
				if (!match) {
					ctx.ui.notify(`Brief matching "${args}" not found.`, "error");
					return;
				}
				selectedBrief = match;
			} else {
				// Interactive selection
				const selected = await ctx.ui.select(
					"Select a brief:",
					briefs
				);
				if (!selected) return;
				selectedBrief = selected;
			}

			// Load and validate the brief
			const briefPath = join(briefsDir, selectedBrief, "brief.md");
			if (!existsSync(briefPath)) {
				ctx.ui.notify(`Brief file not found: ${briefPath}`, "error");
				return;
			}

			briefContent = readFileSync(briefPath, "utf-8");
			briefName = selectedBrief;

			const missing = validateBrief(briefContent, config.brief_sections);
			if (missing.length > 0) {
				ctx.ui.notify(
					`Brief is missing required sections: ${missing.join(", ")}.\nSee brief-template.md for the required format.`,
					"error"
				);
				return;
			}

			// Initialize session
			sessionId = generateSessionId();
			meetingStartTime = Date.now();
			totalCost = 0;
			roundCount = 0;
			meetingComplete = false;
			finalElapsedMinutes = 0;

			// Create deliberation directory
			deliberationDir = join(
				cwd,
				config.paths.deliberations,
				`${selectedBrief}-${sessionId}`
			);
			mkdirSync(deliberationDir, { recursive: true });

			conversationLogPath = join(deliberationDir, "conversation.jsonl");
			toolUseLogPath = join(deliberationDir, "tool-use.jsonl");

			// Create memo directory
			memoDir = join(cwd, config.paths.memos, `${selectedBrief}-${sessionId}`);
			mkdirSync(memoDir, { recursive: true });
			memoPath = join(memoDir, "memo.md");

			meetingActive = true;

			// Log meeting start
			logConversation({
				type: "meeting_start",
				session_id: sessionId,
				timestamp: new Date().toISOString(),
				brief: briefPath,
				board_members: Array.from(boardStates.keys()).map(displayName),
				constraints: config.meeting.constraints,
			});

			// Reset all board member states
			for (const [, state] of boardStates) {
				state.status = "idle";
				state.messageCount = 0;
				state.cost = 0;
				state.contextPct = 0;
				state.lastWork = "";
				state.elapsed = 0;
			}

			updateWidget();

			ctx.ui.notify(
				`Deliberation started: ${selectedBrief}\nSession: ${sessionId}\nMemo will be written to: ${memoPath}`,
				"success"
			);

			// Build the CEO's scratch pad path for the trigger message
			const saExpertisePath = agentDefs.get("solution-architect")?.expertise
				.filter(e => e.updatable)
				.map(e => join(cwd, e.path)) ?? [];
			const scratchPadInstruction = saExpertisePath.length > 0
				? `**⚠️ MANDATORY FIRST STEP:** Before calling converse, you MUST:\n` +
				  `1. Read your scratch pad: ${saExpertisePath[0]}\n` +
				  `2. Write to your scratch pad with key facts from the brief, your initial framing, and any priors from previous sessions.\n` +
				  `Only AFTER completing both read and write may you call converse.\n\n`
				: "";

			// Send initial message to CEO
			pi.sendMessage(
				{
					customType: "deliberation-start",
					content:
						`**Deliberation started.** Session ${sessionId}.\n\n` +
						scratchPadInstruction +
						`**Brief:** ${selectedBrief}\n\n` +
						briefContent + "\n\n" +
						`**Board Members:** ${Array.from(boardStates.keys()).map(displayName).join(", ")}\n\n` +
						`**Constraints:** ${config.meeting.constraints.min_time_minutes}-${config.meeting.constraints.max_time_minutes} min, $${config.meeting.constraints.min_budget}-$${config.meeting.constraints.max_budget}\n\n` +
						`**Memo Path:** ${memoPath}\n\n` +
						`After updating your scratch pad, use \`converse(to, message)\` to engage the board. Frame the decision clearly.\n\n` +
						`Remember: update your scratch pad after EACH converse round with shifting positions, tensions, and your evolving thesis.`,
					display: true,
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		},
	});

	// ── Footer (set in session_start) ───────────

	function setupFooter(ctx: any) {
		ctx.ui.setFooter((_tui: any, theme: any, _footerData: any) => ({
			dispose: () => {},
			invalidate() {},
			render(width: number): string[] {
				if (!meetingActive) {
					// Idle: single line
					const left = theme.fg("accent", " SA") + theme.fg("dim", "  ·  ") + theme.fg("muted", "idle");
					const right = theme.fg("dim", "Run /migrate-begin ");
					const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
					return [truncateToWidth(left + pad + right, width, "")];
				}

				const cs = getConstraintState();
				const costColor = cs.budget_spent > cs.max_budget * 0.8 ? "error" : "warning";
				const timeColor = cs.elapsed_minutes > cs.max_time * 0.8 ? "error" : "accent";

				// Line 1: CEO label + context meter (left), cost + time (right)
				const usage = ctx.getContextUsage?.();
				const pct = usage?.percent ?? 0;
				const filled = Math.round(pct / 10);

				const l1Left =
					theme.fg("accent", " SA") +
					theme.fg("dim", "  ") +
					theme.fg("warning", "[") +
					theme.fg("success", "#".repeat(filled)) +
					theme.fg("dim", "-".repeat(10 - filled)) +
					theme.fg("warning", "]") +
					theme.fg("dim", " ") +
					theme.fg("accent", `${Math.round(pct)}%`);

				const l1Right =
					theme.fg(costColor, `$${cs.budget_spent.toFixed(2)}`) +
					theme.fg("dim", "  ") +
					theme.fg(timeColor, `${cs.elapsed_minutes}m`) +
					theme.fg("dim", " ");

				const pad1 = " ".repeat(Math.max(1, width - visibleWidth(l1Left) - visibleWidth(l1Right)));
				const line1 = truncateToWidth(l1Left + pad1 + l1Right, width, "");

				// Line 2: session + round + phase (left), board status summary (right)
				const phase = meetingComplete ? "complete" : cs.elapsed_minutes >= cs.max_time * 0.8 ? "converging" : "deliberating";
				const phaseColor = phase === "complete" ? "success" : phase === "converging" ? "warning" : "muted";

				const l2Left =
					theme.fg("dim", " [") +
					theme.fg("accent", sessionId) +
					theme.fg("dim", "]  ") +
					theme.fg("warning", `R${roundCount}`) +
					theme.fg("dim", "  ") +
					theme.fg(phaseColor, phase);

				const responding = Array.from(boardStates.values()).filter(s => s.status === "responding").length;
				const done = Array.from(boardStates.values()).filter(s => s.status === "done").length;
				const idle = Array.from(boardStates.values()).filter(s => s.status === "idle").length;

				const l2Right =
					theme.fg("success", `${done}`) + theme.fg("dim", " done  ") +
					theme.fg("accent", `${responding}`) + theme.fg("dim", " active  ") +
					theme.fg("muted", `${idle}`) + theme.fg("dim", " idle ");

				const pad2 = " ".repeat(Math.max(1, width - visibleWidth(l2Left) - visibleWidth(l2Right)));
				const line2 = truncateToWidth(l2Left + pad2 + l2Right, width, "");

				return [line1, line2];
			},
		}));
	}

	// ── Session End — finalize meeting ───────────

	pi.on("session_end", async (_event: any, _ctx: any) => {
		if (meetingActive) {
			const cs = getConstraintState();
			logConversation({
				type: "meeting_end",
				session_id: sessionId,
				timestamp: new Date().toISOString(),
				elapsed_minutes: cs.elapsed_minutes,
				total_cost: cs.budget_spent,
				end_reason: "session_end",
			});
			meetingActive = false;
		}
	});
}
