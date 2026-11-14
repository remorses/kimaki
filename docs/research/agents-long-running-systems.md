---
title: Agents that run long-lived systems, read from the source code
description: What the code of 20 open repos actually does for agents that run a business, a channel or a research program for weeks. Agent loop, wakes, memory, tools, metric and feedback, with file and line citations. Claims that only come from a paper or blog are marked. Read 2026-11-13.
---

# Agents that run long-lived systems, read from the source code

This report comes from the **source code** of 20 repos, all cloned with `opensrc` on 2026-11-13. Every claim about a repo cites `repo:path:Lstart-Lend`. A claim marked **[paper]**, **[blog]** or **[README]** was not found in code. Projects without public code are in a separate section at the end; all of their claims are from blogs.

The skill built from this report is `~/.config/opencode/skills/self-running-agent/` (SKILL.md, `kit.ts`, and a science and space TikTok example).

The short version: every good implementation keeps the agent's real memory **outside the chat**, wakes it on a clock, hands it a short **digest of what changed**, makes it end each wake explicitly, and settles outcomes **later**, in code, before any lesson is written.

```
cron / clock ──▶ wake script builds briefing ──▶ agent acts (capped) ──▶ agent calls done
     ▲            (time, budget, deltas since      │ reads memory.md, lessons     │
     │             cursor, due reminders, inbox)   │ writes memory.md, schedule   │
     │                                             ▼                              ▼
     │                                   external system changes      state.json saved atomically
     │                                             │
     └──── settle script (code only) ◀── outcomes arrive late (sales, views, returns)
                     │
                     ▼
         learn wake rewrites lessons.md (separate role, capped, generic rules only)
```

## How to read the citations

Run `opensrc path <owner/repo>` to get the root. Short names used below:

| short | repo | read |
| --- | --- | --- |
| `vb` | ProsusAI/vending-bench | engine `tasks/vending-bench/environment/sim-server/vending/engine.py` (cited as `eng`) |
| `ecb` | QwenLM/E-CommerceBench | agent, tool manager, env |
| `mb` | KhanCold/merchantbench | env simulator, routes, ReAct baseline |
| `rlg` | SaharaLabsAI/ReLiveGym | runtime, harness, reddit tasks |
| `ga` | joonspk-research/generative_agents | `reverie/backend_server/persona/` (cited as `P/`) |
| `ta` | TauricResearch/TradingAgents | `tradingagents/` (cited as `T/`) |
| `voy` | MineDojo/Voyager | `voyager/` |
| `fle` | JackHopkins/factorio-learning-environment | `fle/` |
| `asv2` | SakanaAI/AI-Scientist-v2 | `ai_scientist/treesearch/` |
| `oe` | codelion/openevolve | `openevolve/` |
| `dgm` | jennyzzt/dgm | root |
| `robin` | Future-House/robin | `robin/` |
| `vlab` | zou-group/virtual-lab | `src/virtual_lab/` |
| `oasis` | camel-ai/oasis | `oasis/` |
| `edcg` | mminici/Engagement-Driven-Content-Generation | `src/` |
| `biomni` | snap-stanford/Biomni | `biomni/agent/a1.py` |
| `mpt` | harry0703/MoneyPrinterTurbo | `app/services/` |
| `tac` | TheAgentCompany/TheAgentCompany | `workspaces/`, `evaluation/` |
| `rb` | linghuazhang01/RetailBench | see section 2 |
| `mm` | microsoft/multi-agent-marketplace | see section 2 |

## 1. Business simulators with a clock

### Vending-Bench, open reimplementation (`vb`)

- **The simulator is a passive MCP server; the harness owns the loop.** One turn is one chat completion, then its tool calls run one after another (`vb:scripts/run_openrouter.py:L202-L269`). After 3 turns with no tool call the run stops (`L267-L269`).
- **Every tool call costs simulated minutes** (5 to 45, `vb:.../config.toml:L79-L108`). The day runs 09:00 to 17:00. `wait_for_next_day` jumps to the next morning and runs end-of-day processing (`eng:L1457-L1469`). Time moves only through tool calls.
- **Memory is notes plus reminders, nothing else.** `write_note(key, text)` / `read_notes` (`eng:L1398-L1430`). The tool description says notes "survive anything being trimmed from your context" (`vb:.../server.py:L159-L166`). Reminders fire once in a later morning briefing (`eng:L293-L295`). No vector store, no summarizer.
- **Context**: the harness keeps system and user messages plus the newest whole exchanges that fit 60k chars (`run_openrouter.py:L51-L61`), and tells the agent so (`L38-L42`).
- **Feedback is pushed, batched overnight.** Sales, supplier replies (1 day late), delayed deliveries, short shipments and complaints are all computed in `end_of_day` (`eng:L176-L275`). They are appended to whatever tool result crosses the day, with a `[Day N/30 — date — balance]` status line (`eng:L812-L824`).
- **Metric**: `max(0, balance)` only if the run finished and did not go bankrupt, else 0 (`eng:L375-L380`). Bankrupt after more than 10 unpaid daily fees (`eng:L256-L265`).
- **State**: one JSON dict written atomically (tmp + rename) after every call; resumable (`eng:L94-L100`, `server.py:L27-L31`).
- Tool descriptions label irreversible actions ("No preview invoice or cancellation", `server.py:L93-L94`, `L211-L212`).

### E-Commerce Bench (`ecb`)

- **Loop**: `while turn < max_turns` (`ecb:agent/ecommerce_agent.py:L187-L416`). Each turn: context editing, one LLM call with all tool schemas, sequential tool calls. No tool call gets a nudge; 3 in a row end the run as `agent_idle` (`L321-L347`).
- **Day boundary**: a `wait_for_next_day` call, or any tool whose time cost passes 18:00 (`ecb:tools/ecommerce_env.py:L2596-L2621`). The workday is 600 minutes and tools cost 10 to 60 (`L70`), so time is the per-day action budget.
- **Memory**: `operate_memory`, a title→content dict of at most 20 memos (`ecb:tools/operate_memory.py:L5-L85`). It lives in RAM only (`ecommerce_env.py:L173`).
- **Context**: above 120k tokens, the oldest tool groups are dropped with no summary; the system message, the first user message and the 2 newest groups stay (`ecb:context_manager/context_editor.py:L75-L184`). The agent gets a `<system_warning>` the same turn and a token gauge on every result (`ecommerce_agent.py:L227-L271`, `L383-L392`).
- **Feedback**: sales land one day late (`ecommerce_env.py:L2443`), money settles 9 days after shipping (`L74`), returns arrive 3 to 7 days later (`L966-L991`). Buffered events are drained into `system_notifications` on the next result (`ecb:agent/ecommerce_tool_manager.py:L446-L516`). Detailed reports are pulled, not pushed (`L412-L414`). A balance alarm is pushed when cash is low (`L518-L547`).
- **Determinism**: demand is a closed-form product of factors with seeded rounding (`ecommerce_env.py:L1949-L2024`). Supplier decisions come from a seeded kernel; the LLM only writes the wording ("You MUST incorporate these exact prices…", `ecb:tools/opponent/supplier_llm.py:L78-L83`). Exception: a VIP-fee classifier is an LLM that charges money (`ecb:tools/opponent/scam_handler.py:L77-L110`).
- **Metric**: final total assets ÷ initial (`ecommerce_tool_manager.py:L728-L729`), after settling all pending orders and returns (`ecommerce_env.py:L2659-L2715`).
- **There is no reflection step and no lessons file.** "Learning over the horizon" is only measured after the run (`ecb:tools/opponent/negotiation_tracker.py:L169-L293`). **[README]**: "¥ per tool call" efficiency axis and the radar profile have no code.

### MerchantBench (`mb`)

- **The world runs on its own clock; the agent is a hook.** One tick is one simulated hour (`mb:env/core/simulator.py:L268-L461`). The agent wakes every 12 ticks (`activation_period: 12`, `mb:env/scenarios/default.yaml:L193`), about 730 wakes per year. Off-ticks run with no agent.
- **State is committed before the agent looks**, with a resume marker (`simulator.py:L444-L449`, `L270-L282`).
- **A wake ends with `end_of_step`**, which must be the last call (`mb:env/web/routes_agent.py:L1020-L1023`). Hard limits: 30 LLM hops per wake, 1800 s per hook, a turn quota; every failure path forces `end_of_step` (`mb:agent/baselines/react_160k_compact_30k.py:L730-L734`).
- **Each wake gets a change digest, not the full state**: counters since the persisted `last_observed_step` cursor (`mb:env/tools/observation.py:L708-L721`, `L1127-L1141`). Drill-down tools reuse the same window (`query_order_updates`, `query_supply_chain_anomalies(mode='new')`).
- **Memory**: one markdown file per agent, overwritten whole, 256 KiB cap, and every write also appended to a versioned history file (`mb:env/tools/tools.py:L2161-L2227`). It is never auto-loaded; the agent must read it.
- **Context**: at 160k tokens the agent is told "Call write_memory_doc now if important details should be kept", then history is trimmed to 30k with no summary (`react_160k_compact_30k.py:L315-L321`, `L483-L539`).
- **Delayed outcomes**: each order's fate is drawn at creation and hidden until its status changes (`mb:env/core/demand.py:L194-L243`). Results carry a `profit_finalized` flag (`mb:env/tools/registry.py:L325-L330`).
- **Safety**: stale-step guard rejects actions planned on an old observation (`routes_agent.py:L219-L236`); idempotency key per mutating call (`L1052-L1062`).
- **Metric**: last `net_assets = balance + deposit_pool + in_transit + receivable` (`simulator.py:L1318-L1332`, `mb:eval/scoring.py:L33-L75`).
- **[README]**: the Hermes framework internals live in another repo; only the launcher is here (`mb:env/web/runner.py:L1086-L1183`).

### RetailBench and Magentic Marketplace (`rb`, `mm`)

Paths: `rb:` is the RetailBench root; `mm:` is `packages/magentic-marketplace/src/magentic_marketplace`.

- **RetailBench days have two phases with separate message lists**: a strategy phase (at most 10 turns, no order or price tools, ends on `END`) and an execution phase (at most 20 turns, ends on `end_today`, forced at the cap) (`rb:run_env.py:L697-L1148`).
- **No chat history crosses a day.** Only a structured strategy JSON (`macro_strategy`, `execute_strategy`, `today_action`) and yesterday's computed report are carried (`rb:module/strategy_manager.py:L15-L37`, `rb:run_env.py:L724-L734`).
- **The harness writes the daily report**: funds, net worth, earnings, stockouts, sales, returns and expired items per SKU (`rb:retail_environment.py:L466-L531`). Reviews and news must be pulled with tools.
- **Compared frameworks in code**: one daily reflection that replaces the old one (`rb:agents/run_reflection.py:L672-L690`); a ring of the last 5 step reflections (`rb:agents/run_step_reflection.py:L637-L639`); plan-and-act (`rb:agents/run_plan_and_act.py:L250-L312`); a fixed strategy ablation.
- **Bugs**: notes live in process memory and are not checkpointed (`rb:retail_environment.py:L1348-L1367`); two different net-worth formulas (`L390` vs `L450-L457`); the expiry comment says "0.6x" but the code uses 0 (`rb:module/inventory.py:L231-L254`).
- **Survival rule in code**: 5 days in a row with negative funds ends the run (`rb:run_env.py:L1064-L1070`). The "oracle" is a heuristic that reads hidden supplier quality and news effects (`rb:retail_environment.py:L3637-L3912`).
- **[README]** `agents/run_react.py`, `hard_v2` and the run-selection rule are not in the repo.
- **Magentic Marketplace**: the customer agent re-renders its whole event history every step (`mm:marketplace/agents/customer/prompts.py:L137-L148`). It loops again at once when new messages arrive, and the prompt pushes it to pay early (`mm:marketplace/agents/customer/agent.py:L125-L130`, `prompts.py:L129`). There is no barrier that waits for all proposals, which is where first-proposal bias comes from in code. Business descriptions go into the customer prompt unfenced, which is how the prompt-injection experiments work (`prompts.py:L197-L198`). Welfare = `2·Σ requested prices` if needs are met, minus payments (`experiments/run_analytics.py:L384-L442`). **[README]** "fairness" and "efficiency" metrics have no code.

## 2. Long-lived agents in a replayed real world: ReLiveGym (`rlg`)

This is the closest code to "an agent that wakes on a schedule for weeks".

- **A step is one LLM call that must return `{"tool","args","thought"}` JSON**, then the tool runs (`rlg:scaffolds/runtime/agent.py:L249-L325`).
- **Four wake designs**, which differ only in the wait tools (`rlg:harness/apps.py:L328-L370`):

| design | how the agent wakes | code |
| --- | --- | --- |
| A | the agent calls `sleep(until)` | `rlg:harness/apps.py:L187-L235` |
| B | the agent writes a Python watcher that polls for free and hands over a ≤16 KB summary | `rlg:harness/authored.py:L326-L393` |
| C | fixed cron only | `rlg:tasks/daily_reddit_digest/agent/scaffolds/cron_react_main.py:L168-L172` |
| D | fixed cron plus agent-owned schedules with a note to its future self | `rlg:harness/schedule.py:L192-L229`, `apps.py:L97-L184` |

- **The wake marker carries the agent's own note**: "Your note for this schedule: …" (`agent.py:L74-L84`). The first wake of a day adds a budget line (`rlg:harness/runtime.py:L127-L164`).
- **The agent cannot strand itself**: with nothing scheduled, a fallback midnight trigger restarts it (`schedule.py:L339-L348`).
- **Runaway guards**: at most 30 calls per cron firing (`cron_react_main.py:L66`), 200 calls without a wait ends the process (`agent.py:L327-L336`), a 120 s idle watchdog (`rlg:scaffolds/runtime/actor.py:L44-L62`).
- **Memory**: `state.json` with atomic write ("anything you want to remember between runs must live in a file", `rlg:scaffolds/runtime/state.py:L1-L24`), append-only `memory/records.jsonl` (`rlg:scaffolds/runtime/memory.py:L26-L47`), `memory/skills.md` with a version counter (`rlg:scaffolds/runtime/skills.py:L23-L40`).
- **Context**: over 60k tokens, whole old wake segments are dropped; the current one is kept; a never-trimmed history file is kept next to it (`agent.py:L96-L140`).
- **Feedback is ingested by code, not by the agent** ("the agent cannot forget to remember"), with a cursor in `state.json` (`memory.py:L8-L12`, `L416-L433`).
- **Learning is a separate wake.** A daily `learn` cron (`30 0 * * *`, `rlg:harness/config.py:L38-L41`) runs a reviewer prompt: "You are NOT that program: you are its once-per-learning-cycle reviewer… drop rules the evidence no longer supports" (`rlg:tasks/reddit_ai_popularity/agent/prompts/reflect.md:L3-L9`). It replaces one markdown block under a token cap (`rlg:scaffolds/runtime/reflect.py:L237-L267`).
- **Lessons are kept general**: the self-review arm grades each claim after 24 h, logs missed opportunities, keeps at most 6 lessons with no ids, dates or names, and ends the block with "Treat this block as fallible feedback" (`rlg:tasks/breakout_news_pm/agent/ext_candidates/tmA-reflection-only/reflective.py:L168-L346`).
- **Self-repair**: crash logs the agent can read, the program snapshotted per edit, `git reset --hard` after 2 crashes following a self-edit (`actor.py:L259-L295`, `rlg:harness/supervisor.py:L199-L215`).
- **[README]**: the "verified curation" arm imports `replay.py`, `rollout.py` and `prompts/reflect_verified*.md`, which are not in the repo. The datasets are not shipped.

## 3. Memory and reflection

### Generative Agents (`ga`)

- **Memory stream**: nodes with `created`, `last_accessed`, `poignancy` 1-10 rated by an LLM, keywords, embedding, and `filling` = evidence node ids (`ga:P/memory_structures/associative_memory.py:L19-L43`, `ga:P/prompt_template/v3_ChatGPT/poignancy_event_v1.txt:L12`).
- **Scored retrieval** = `0.5·recency + 3·relevance + 2·importance`, each min-max normalized (`ga:P/cognitive_modules/retrieve.py:L224-L249`).
- **Bug**: recency is by rank and inverted. Nodes sort oldest first and get `0.99**i`, so after normalization the **oldest** memory scores highest (`retrieve.py:L145-L146`, `L224-L228`). **[paper]** describes exponential decay over game hours.
- **Reflection fires on an importance budget**: each event subtracts its poignancy from 150; at ≤0 it reflects over everything since the last reflection (`ga:P/cognitive_modules/reflect.py:L152-L169`, `ga:P/memory_structures/scratch.py:L61`).
- **Two-step reflection**: 3 questions, then 5 insights in the form "insight (because of 1, 5, 3)"; the numbers map back to node ids and are stored as evidence (`reflect.py:L42-L55`, `L122-L132`).
- **Unused fields**: `expiration` and several reflection thresholds are written but never read (`scratch.py:L49-L64`). **[paper]** forgetting is not in code.

### TradingAgents, current code (`ta`)

- **The paper's vector/BM25 memory and `reflect_and_remember` are gone**; a test checks they no longer exist (`ta:tests/test_memory_log.py:L902-L919`).
- **Memory is one append-only markdown file** (`ta:T/memory/log.py`). Each entry starts `[date | ticker | rating | pending]`; entries are separated by `<!-- ENTRY_END -->`, a string that "cannot appear in LLM prose output" (`log.py:L14-L15`, `L57-L60`). File lock, idempotent per date and ticker (`L46-L55`), atomic rewrite (`L201-L203`).
- **Settle later, in code**: an entry stays pending until the full holding window (default 5 days) has traded (`ta:T/memory/settlement.py:L82-L109`). The outcome is alpha against a benchmark, not the raw return (`L118-L121`). A provider failure leaves it pending (`L173-L178`).
- **Lesson format**: "exactly 2-4 sentences… say so plainly if the window is too short to judge… One concrete lesson" (`ta:T/memory/reflection.py:L22-L33`).
- **Retrieval is recency plus key match**: up to 5 same-ticker entries in full and 3 other-ticker reflections, settled only, and never resolved after "now" (`log.py:L93-L133`). Only the final decider reads them (`ta:T/graph/setup.py:L157-L159`).

### Voyager (`voy`) and Factorio Learning Environment (`fle`)

- **Voyager's context never grows**: the message list is always `[system, human]`, rebuilt each attempt from the last code, the error, the chat log and the critique (`voy:voyager/voyager.py:L196`, `L264`; `voy:voyager/agents/action.py:L130-L197`).
- **Skills are saved only after the critic passes** (`voyager.py:L353-L354`). Stored as `code/<name>.js`, a one-line `description/<name>.txt` and a vector index of the description only (`voy:voyager/agents/skill.py:L28-L30`, `L80-L112`). Same name again gives `nameV2.js` (`L71-L79`). Top-5 retrieved by description (`L114-L127`).
- **Critic**: strict JSON `{reasoning, success, critique}`; any execution error fails without an LLM call (`voy:voyager/agents/critic.py:L39-L42`, `voy:voyager/prompts/critic.txt:L19-L24`). At most 4 retries, then the task goes to `failed_tasks` (`voyager.py:L266-L268`).
- **Curriculum** sees completed tasks and "Failed tasks that are too hard" (`voy:voyager/agents/curriculum.py:L178-L205`) and must propose tasks checkable from state (`voy:voyager/prompts/curriculum.txt:L33`). **[paper]** "failed tasks are revisited later": there is no scheduler, only the list in the prompt.
- **FLE runs code as the action**, one top-level statement at a time; on error it stops, shows the failing line, and rolls persistent variables back (`fle:fle/env/namespace.py:L1084-L1170`). Every `def` the agent writes persists and is shown back as "Available Functions" (`namespace.py:L623-L641`).
- **FLE memory**: the last 16 messages verbatim; every 16 messages an LLM merges a rolling report with sections EXISTING STRUCTURES, ERROR TIPS and NAMESPACE into the system message (`fle:fle/agents/formatters/recursive_report_formatter.py:L14-L67`, `L306-L341`). Old observations become `<STALE_ENTITY_DATA_OMITTED/>` (`L186-L212`).
- **FLE metric**: production score delta, plus an "automated" score that removes manual work (`fle:fle/env/tools/agent/score/server.lua:L391-L408`). Throughput is re-measured until it stops improving (`fle:fle/eval/tasks/throughput_task.py:L74-L86`).
- **FLE gap**: resume restores the game but replaces the conversation with a fresh one (`fle:fle/eval/algorithms/independent/trajectory_runner.py:L200-L214`).

## 4. Search over variants: keep what works

### AI-Scientist-v2 (`asv2`)

- **A journal of nodes**: plan, code, output, metric, `is_buggy`, plot feedback, parent and children (`asv2:journal.py:L44-L118`). Written to disk each step as `journal.json`, `best_solution_<id>.py`, `stage_progress.json`.
- **Parent selection**: first 3 drafts; then with probability 0.5 debug a random buggy leaf up to depth 3; else expand the best node (`asv2:parallel_agent.py:L1931-L2051`, `asv2:bfts_config.yaml:L36-L76`).
- **"Best" is chosen by an LLM** from id, metric and analysis; the max metric is only the fallback (`asv2:journal.py:L420-L502`).
- **Memory in the prompt**: an LLM summary of good nodes and buggy nodes as "patterns of success / failure patterns / recommendations" (`journal.py:L504-L548`). A tried-list with "Ensure the hyperparameter is different from previous attempts" (`parallel_agent.py:L1802-L1821`).
- **The winner is rerun with 3 seeds** before it counts (`asv2:agent_manager.py:L736-L751`).
- **No resume**: `checkpoint.pkl` is written but nothing loads it (`agent_manager.py:L249-L272`).

### OpenEvolve (`oe`)

- **One record per program**: parent id, change description, metrics, parent metrics, generation, artifacts (`oe:openevolve/database.py:L88-L123`), one JSON file each (`L1019-L1029`).
- **MAP-Elites grid**: features are binned; a program takes a cell only if the cell is empty or it is better (`database.py:L444-L471`, `L1031-L1097`).
- **Parent selection**: 20% random, 70% from the elite archive, 10% fitness-weighted (`database.py:L622-L637`, `oe:openevolve/config.py:L343-L345`). Islands with ring migration every 50 generations (`database.py:L2081-L2170`).
- **Prompt history**: each attempt is labelled improved, regressed or mixed against its parent's metrics (`oe:openevolve/prompt/sampler.py:L298-L329`). "Previous Attempts" are the island's top-scored programs, not the latest ones (`oe:openevolve/process_parallel.py:L269`, `L285`).
- **Cascade evaluation**: stage 2 runs only if stage 1 reaches the threshold (`oe:openevolve/evaluator.py:L532-L539`). Failed evaluations do not count toward the early-stopping plateau (`process_parallel.py:L1005-L1017`).

### Darwin Gödel Machine (`dgm`)

- **Archive** of agent versions, each a folder with `metadata.json`, the patch and the chat log; one line per generation in `dgm_metadata.jsonl`, resumed from the last line (`dgm:DGM_outer.py:L15-L35`, `L325-L332`).
- **Parent selection**: `sigmoid(10·(score−0.5)) × 1/(1+children)` (`DGM_outer.py:L92-L100`). Strong parents get more children; busy parents cool down.
- **One change per child**: a diagnosis prompt over one failure log must choose "ONE" improvement (`dgm:prompts/self_improvement_prompt.py:L77-L120`).
- **Bugs**: the `best` mode sorts ascending and picks the worst parents (`DGM_outer.py:L103-L104`); a missing comma in the argparse choices merges two option names (`L228`). `full_eval_threshold` is passed but never used (`dgm:self_improve_step.py:L234`). **[README]** full evaluation of top nodes.

## 5. Research teams

### Robin (`robin`)

- **One cycle is three functions the human runs from notebook cells**: propose and rank formats, then generate and rank candidates inside the winner, then analyse returned data (`robin:robin/assays.py:L34-L277`, `robin:robin/candidates.py:L71-L547`, `robin:robin/analyses.py:L55-L201`). There is no loop or scheduler in code.
- **Ranking**: a pairwise LLM judge returns JSON `{Analysis, Reasoning, Winner, Loser}` (`robin:robin/utils.py:L584-L661`), at most 300 pairs, then a Bradley-Terry fit with `choix.ilsr_pairwise` and top-1 (`assays.py:L231-L243`). Rubric: judge on evidence and rigor, "not on the persuasive quality or wording" (`robin:robin/prompts.py:L464-L466`).
- **Weaknesses**: no position swap (lower id always in slot 1), no ties (`utils.py:L452`).
- **Feedback**: analysis returns already-tested items plus "DO NOT SUGGEST THESE … AGAIN", appended to the next generation prompt (`analyses.py:L190-L195`, `candidates.py:L55-L69`).
- **Bug**: the second pass ranks the old folder (`candidates.py:L334-L336`). `followup_suggestions` is computed and never read (`analyses.py:L186-L201`). **[README]** "multi-agent system": the agents are remote job names; locally it is a linear script.

### Virtual Lab (`vlab`)

- **A meeting is one shared transcript**; each speaker gets its own system prompt prepended; the lead speaks last and summarizes (`vlab:run_meeting.py:L34-L270`).
- **Critic that only critiques**: "Only provide feedback; do not implement the answer yourself", then the author revises (`vlab:prompts.py:L291-L321`).
- **Fixed-section summary is the only memory carried forward**: Agenda, Team Member Input, Recommendation, Answers, Next Steps (`prompts.py:L54-L84`). Later phases load only `merged.json` summaries (`vlab:utils.py:L299-L320`).
- **5 parallel meetings at temperature 0.8, merged by the lead at 0.2**, with "explain what components … came from each individual answer" (`prompts.py:L29-L51`, `vlab:constants.py:L49-L50`).
- **[README]** "human interacts in individual meetings" and "built a computational pipeline": no human turn exists in code, and agent-written code is never run by it.

## 6. Audience simulation (`oasis`, `edcg`)

- **OASIS step**: rebuild feeds, then each active agent does one LLM call with platform actions as tools (`oasis:oasis/environment/env.py:L136-L198`). Agents see the feed as raw JSON, including like counts, so early likes snowball (`oasis:oasis/social_platform/platform_utils.py:L163-L185`).
- **Recommenders**: random, Reddit hot score, TwHIN-BERT cosine × recency (`oasis:oasis/social_platform/recsys.py`). The TwHIN recency term goes negative after about 172 steps (`recsys.py:L470-L472`). The `twitter` recommender reads a `trace.post_id` column that the schema does not have (`recsys.py:L670`).
- **Usable piece**: `INTERVIEW` asks one persona a free-text question without changing its feed (`oasis:oasis/social_agent/agent.py:L197-L249`). Agents only read text: no video, watch time or completion.
- **EDCG's "engagement" is one sentiment number**: the IMDB sentiment classifier's positive probability drives a bounded-confidence cascade (`edcg:src/sentiment-propagation.py:L428`, `L513-L527`), multiplied by the Flesch-Kincaid grade level (`L507-L508`, `L539`). **[README]** topic alignment and model-agnostic engagement are not in code. Do not copy it.

## 7. Agent tooling and content pipelines (`biomni`, `mpt`, `tac`)

- **Biomni**: the loop alternates `generate` and `execute`. The model must return `<execute>` or `<solution>`, and after 2 format errors the run ends (`biomni:biomni/agent/a1.py:L1415-L1468`). The plan is a checklist the model rewrites each step, marked `[✗] failed because…` (`a1.py:L1102-L1119`). Each output is cut at 10K chars (`a1.py:L1521`). Know-how is stored as md files with a short-description metadata block; one LLM call before the loop picks which ones to load by index (`biomni:biomni/know_how/loader.py:L28-L163`, `biomni:biomni/model/retriever.py:L29-L201`). **[README]** "retrieval-augmented planning" is one pick before the loop.
- **MoneyPrinterTurbo** is a fixed pipeline: preflight, then script, search terms, TTS, subtitles, stock footage and compose. Each stage can stop with `stop_at` (`mpt:app/services/task.py:L1550-L1982`). The script prompt says "get straight to the point… never use a title" (`mpt:app/services/llm.py:L56-L71`). Each clip gets a provider, creator and URL record (`mpt:app/services/material.py:L134-L204`). Default output is 1080×1920 at 30 fps (`mpt:app/models/schema.py:L34-L46`). Upload goes through the paid Upload-Post API. The upload job id is saved before polling (`task.py:L1359-L1376`). TikTok posts get no hashtags because of the prompt rule (`llm.py:L1324-L1347`). **No analytics are read back.**
- **TheAgentCompany**: each task is a folder with `task.md`, a weighted `checkpoints.md` and an `evaluator.py` with one `@grader` per checkpoint (`tac:workspaces/tasks/admin-ask-for-meeting-feedback/`). A grader exception counts as a fail (`tac:workspaces/base_image/common.py:L35-L47`). Score = `(result/total)·0.5 + (result//total)·0.5` (`tac:evaluation/summarise_results.py:L162-L178`). Fuzzy checks use an LLM yes/no predicate (`common.py:L214-L281`).

## 8. Patterns, and where each one is in code

| pattern | code |
| --- | --- |
| Memory in files, and tell the agent the chat is lost | `vb:server.py:L159-L166`, `ecb:agent/prompts.py:L8-L10`, `rlg:scaffolds/runtime/state.py:L1-L24` |
| One overwrite-only memory doc + append-only versioned history, size cap | `mb:env/tools/tools.py:L2161-L2227` |
| Bounded memory slots (20) | `ecb:tools/operate_memory.py:L5-L85` |
| Warn before context loss so the agent saves notes | `mb:react_160k_compact_30k.py:L315-L321`, `ecb:ecommerce_agent.py:L227-L271` |
| Wake on a clock; agent ends the wake explicitly | `mb:env/scenarios/default.yaml:L193`, `mb:routes_agent.py:L1020-L1023`, `vb:eng:L1457-L1469`, `rlg:agent.py:L47-L55` |
| Agent-owned schedules with a note to its future self + fixed base cron + fallback | `rlg:harness/schedule.py:L192-L348`, `rlg:agent.py:L74-L84` |
| Briefing per wake: time, money, deltas since cursor, due reminders | `vb:eng:L277-L296`, `mb:observation.py:L708-L721`, `rlg:runtime.py:L127-L164` |
| Events buffered by code, drained into the next wake | `ecb:ecommerce_tool_manager.py:L446-L516`, `vb:eng:L812-L824` |
| Pull reports, push only alarms | `ecb:ecommerce_tool_manager.py:L412-L414`, `L518-L547` |
| Action budget per wake; nudge when idle; stop after 3 idle turns | `vb:config.toml:L79-L108`, `vb:scripts/run_openrouter.py:L252-L269`, `ecb:ecommerce_agent.py:L321-L347`, `mb:react…py:L730-L734` |
| State written atomically after every action; resume marker | `vb:eng:L94-L100`, `mb:simulator.py:L444-L449`, `ta:T/memory/log.py:L201-L203` |
| Idempotency key and stale-plan guard on mutations | `mb:routes_agent.py:L219-L236`, `L1052-L1062` |
| Outcomes settled later by code; pending until the window closes; compared to a baseline | `ta:T/memory/settlement.py:L82-L121`, `mb:registry.py:L325-L330`, `rlg:memory.py:L416-L433` |
| Separate learn wake, reviewer role, capped generic lessons, "fallible" warning | `rlg:harness/config.py:L38-L41`, `rlg:tasks/reddit_ai_popularity/agent/prompts/reflect.md:L3-L9`, `rlg:tasks/breakout_news_pm/agent/ext_candidates/tmA-reflection-only/reflective.py:L168-L346` |
| Lessons in 2-4 sentences naming the evidence window | `ta:T/memory/reflection.py:L22-L33` |
| Insights cite evidence ids | `ga:P/cognitive_modules/reflect.py:L42-L55` |
| Skill saved only after a check passes; short description index; versioned | `voy:voyager.py:L353-L354`, `voy:skill.py:L71-L127` |
| Critic with strict JSON; errors fail without an LLM call | `voy:critic.py:L39-L42`, `vlab:prompts.py:L291-L321` |
| Rolling report with fixed sections | `fle:fle/agents/formatters/recursive_report_formatter.py:L14-L67`, `vlab:prompts.py:L54-L84` |
| One record per variant with parent and verdict vs parent | `oe:database.py:L88-L123`, `oe:openevolve/prompt/sampler.py:L298-L329` |
| Grid of niches, one elite per cell; explore/exploit split | `oe:database.py:L444-L471`, `L622-L637` |
| Parent choice: score × 1/(1+children) | `dgm:DGM_outer.py:L92-L100` |
| One change per variant, from a diagnosis of one failure | `dgm:prompts/self_improvement_prompt.py:L77-L120` |
| Tried-list in the prompt; "must differ" | `asv2:parallel_agent.py:L1802-L1821`, `robin:analyses.py:L190-L195` |
| Replicate the winner before trusting it | `asv2:agent_manager.py:L736-L751` |
| Cheap check first, expensive check above a threshold | `oe:evaluator.py:L532-L539`, `dgm:self_improve_step.py:L152-L178` |
| Pairwise judge + Bradley-Terry for drafts | `robin:utils.py:L584-L661`, `robin:assays.py:L231-L243` |
| Many hot drafts, one cool merge | `vlab:prompts.py:L29-L51`, `vlab:constants.py:L49-L50` |
| Crash logs readable by the agent; git rollback after bad self-edits | `rlg:actor.py:L259-L295`, `rlg:supervisor.py:L199-L215` |
| Pipeline with stop points and preflight before spending | `mpt:task.py:L1550-L1982` |
| Source record per media asset | `mpt:material.py:L134-L204` |
| Task folder with weighted checkpoints and fail-closed graders | `tac:workspaces/base_image/common.py:L35-L47`, `tac:summarise_results.py:L162-L178` |

## 9. Things the code says not to copy

- An LLM choosing "best" instead of the metric (`asv2:journal.py:L420-L502`): not reproducible.
- Rank-based, inverted recency (`ga:P/cognitive_modules/retrieve.py:L145`). Use real elapsed time.
- Fields nobody reads (`ga:P/memory_structures/scratch.py:L49-L64`) and checkpoints nobody loads (`asv2:agent_manager.py:L249-L272`).
- A pairwise judge without slot swapping (`robin:utils.py:L452`).
- Simulated engagement from text only (`oasis`, `edcg`) as the reward. Use it only as a pre-filter and check it against real numbers.
- Memory only in RAM (`ecb:tools/ecommerce_env.py:L173`): lost on a crash.

## 10. Projects with no public code (blog and paper claims only)

| project | claim | source |
| --- | --- | --- |
| Vending-Bench 2 and Arena (Andon Labs) | **[blog]** a year-long simulated vending business; top models near $16k; "a good strategy could do about 10× better" | https://andonlabs.com/evals/vending-bench-2 |
| Vending-Bench (original) | **[paper]** failures did not line up with a full context window | https://arxiv.org/abs/2502.15840 |
| Project Vend 1 and 2 (Anthropic + Andon) | **[blog]** a real office shop; phase 2 added a CRM and a "CEO" agent (Seymour Cash) and mostly removed weeks with negative margin | https://www.anthropic.com/research/project-vend-2 |
| Andon Market, Andon Café | **[blog]** real store and café run by agents who hire humans; on Gemini 3.1 Pro the café spent $38k against $9k sales in two months | https://andonlabs.com/blog/andon-market-launch, https://andonlabs.com/blog/why-gemini-lost-money-andon-cafe |
| Andon FM | **[blog]** four AI-run radio stations: buy songs, plan schedule, reply on X, read listener analytics, sell ads | https://andonlabs.com/blog/andon-fm |
| AI Village | **[blog + logs]** merch stores, YouTube channels, Substacks; first-day quantity over quality on YouTube | https://theaidigest.org/village/goal/run-your-own-youtube-channel |
| Kosmos | **[paper]** a structured world model shared by a data agent and a literature agent over about 200 rollouts | https://arxiv.org/abs/2511.02824 |
| Pion, Polsia, HurumoAI, Alpha Arena | **[blog]** commercial or journalistic; no code | https://andonlabs.com/pion, https://polsia.com, https://www.shellgame.co, https://nof1.ai |
