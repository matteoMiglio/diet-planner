# Diet Planner — Spec

> Status: **draft v2 for review** · 2026-11-05 · Owner: Matteo
> v2 adds the independent review's findings and what the real Tanita CSV export showed. The changes are listed in §17.

A self-hosted web app that builds and adjusts my diet from my own body data, tracks how the plan is actually going with as little effort as possible, and rates food I scan.

It replaces the diet machinery in the Obsidian vault (`Diet Plan/`, `Food Pool`, `Diet Planning Rules`, `Body Measurements Log`) with a database and a phone-first UI, without losing what that machinery already gets right.

---

## 1. Goals and non-goals

### Goals

1. **Plan from my data.** Tanita RD-953 readings and check-ins go in, and calorie/macro targets plus a 7-day meal plan come out. The targets are adjusted by the same rules the vault uses today.
2. **Make the cadence happen.** My real failure is the habit, not the planning: food logging lasted one day, and weigh-ins have been every 2–4 weeks instead of weekly. The app _pushes_ (reminders, a weigh-in that takes about 5 seconds) instead of waiting for me to remember.
3. **Scan and rate food.** Scanning a barcode gives a general quality score plus a score for how well the product fits _my current phase and day_, and logging it is one more tap.
4. **Explainable.** Every number shows where it came from. Every change to targets or plans is a proposal I approve, with its reasoning attached.

### Non-goals (v1)

- More than one user, coach roles or social features
- Native apps, offline-first sync, multiple devices editing at the same time
- Micronutrient tracking, recipes with cooking steps
- Integrations (openGym, Apple Health, Strava, an MCP server)
- Writing back to the Obsidian vault (an export is a v2 candidate)
- A public internet login (v1 is reachable only over Tailscale; see §3)

---

## 2. Principles

| Principle                                                                                        | Consequence in the app                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Measure, don't calculate.** Observed maintenance (~2040) beat the formula (~2600) three times. | Formulas only seed a brand-new phase. After that, targets move by fixed-size rule steps driven by the observed trend.                                                                           |
| **One controller.**                                                                              | Only the review decision table (§6.4) changes targets. The maintenance estimate (§6.2) is shown for information and as a guardrail; it never moves targets by itself.                           |
| **BIA body fat is a prediction.**                                                                | BF% and muscle mass are stored and charted as "trend only". They never feed decisions. The tape measure (waist) does.                                                                           |
| **Don't act on noise.** A single reading can swing 1.35 kg in 2 days (05-02 → 05-04).            | The trend uses every reading, robustly. A rule only fires when the trend's uncertainty range lies entirely on one side of the target band; otherwise the result is "hold: need more weigh-ins". |
| **Carbs move, protein holds within a phase, fat holds the floor.**                               | Encoded as fixed rules in the engine. Protein changes only when a new phase starts.                                                                                                             |
| **Numbers come from code; the AI only suggests.**                                                | The model picks foods and combinations. Code recomputes every macro, labels every item's role, fixes portions and checks every rule.                                                            |
| **No step should depend on a habit that has already failed.**                                    | Decisions are gated on a **one-tap weekly adherence answer** in the check-in, not on per-meal tapping. Meal checks are optional extra detail.                                                   |

---

## 3. Users and access

- One user (me). The schema still keeps `user_id` on every table, which is cheap now and avoids a migration later.
- **v1 access is over Tailscale only.** The VM joins my tailnet, and `tailscale serve` provides HTTPS with a valid `*.ts.net` certificate (camera access and web push need HTTPS). The app is never exposed to the public internet. That means no domain and no login code to build: being on my tailnet _is_ the authentication.
- A single API token (in `.env`) authenticates iOS Shortcuts calls to the ingest endpoints (§8.3). It's sent as a bearer header and can be rotated from Settings.
- **v2, only if it ever goes public:** passkeys, with a one-time setup token printed in the server logs for the first registration and a CLI command to recover access. "First visitor registers" is never allowed.

---

## 4. Architecture

```
iPhone / laptop (installed web app, on Tailscale)
        │ HTTPS (tailscale serve, *.ts.net cert)
   ┌────▼──────────────────────────────┐
   │  app (Node 22, one container)     │
   │   ├─ Hono API  /api/*             │  ── Claude API (plan generation, label OCR, narratives)
   │   ├─ static React build  /*       │  ── Open Food Facts API (barcodes)
   │   └─ pg-boss worker (jobs, push)  │  ── Web Push (Apple/Google push services)
   └────┬──────────────────────────────┘
   ┌────▼─────┐        ┌───────────────────────────┐
   │ Postgres │ ─────▶ │ backup: nightly pg_dump,  │──▶ off-site copy (restic → object storage)
   └──────────┘        └───────────────────────────┘
```

| Concern         | Choice                                                         | Why                                                                                                                            |
| --------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Language        | TypeScript end to end                                          | One language. Zod schemas are shared between API, UI and the AI output contract.                                               |
| Frontend        | React 19 + Vite, installable web app                           | Can be installed on the iPhone home screen. Web push works on iOS 16.4+ for installed web apps.                                |
| UI kit          | Tailwind + shadcn/ui                                           | Fast to build, and accessible by default.                                                                                      |
| API             | Hono on Node                                                   | Small and typed. Serves the API and the static build from one origin.                                                          |
| DB              | Postgres 17 + Drizzle ORM                                      | Typed queries, SQL migrations. Status columns are `text` + `CHECK` constraints, not Postgres enums, so changing them is cheap. |
| Jobs            | pg-boss                                                        | AI jobs (M3), with no Redis. Reminders don't need it: a minute timer plus an idempotent log.                                   |
| Solver          | `javascript-lp-solver` (small integer program)                 | The portion solver (§7.5) has about 6–10 variables per day.                                                                    |
| Barcode         | `zxing-wasm`                                                   | iOS Safari has no `BarcodeDetector`.                                                                                           |
| Charts          | Recharts                                                       | Trend lines with target bands.                                                                                                 |
| Tests           | Vitest (engine, validator, importers), Playwright (core flows) |                                                                                                                                |
| Package manager | pnpm workspace: `apps/web`, `apps/api`, `packages/shared`      |                                                                                                                                |

### Hosting and operations

- **Cloud VM**, Docker Compose services: `app`, `db`, `backup`, plus Tailscale on the host.
- `.env` on the VM, never committed: `ANTHROPIC_API_KEY`, `DATABASE_URL`, `INGEST_TOKEN`, `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`, `TZ_DEFAULT=Europe/Rome`, `RESTIC_REPOSITORY`, `RESTIC_PASSWORD`, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` (the OCI Customer Secret Key).
- Images are built **multi-arch (amd64 + arm64)**, so the stack runs on an Oracle Ampere VM, x86, or the Raspberry Pi unchanged.
- **Backups:**
  - Nightly `pg_dump`, kept 14 days locally.
  - A **restic copy to Oracle Cloud Object Storage** through its S3-compatible endpoint (`https://<namespace>.compat.objectstorage.<region>.oraclecloud.com`, using a Customer Secret Key), kept 90 days. The bucket is private, and restic's own encryption is on. Any S3-compatible bucket works by changing the endpoint.
  - A **monthly automated restore test**: it restores the newest off-site snapshot into a throwaway database, checks it, and drops it again. It logs `FAILED` if anything breaks; once web push exists (M1), a failure also sends a notification.
  - A JSON export of everything from Settings.
- The Raspberry Pi stays possible later (same compose file, same Tailscale setup).

---

## 5. Data model

Every table has `id` (uuid), `user_id`, `created_at` and `updated_at`. Weights are in kg; food amounts in g or ml. Timestamps are stored in UTC. **Calendar days are computed in `profile.timezone`.**

### 5.1 Profile and settings

**`profile`**: `sex`, `birth_date`, `height_cm`, `timezone` (default `Europe/Rome`), `activity_factor` (numeric, default 1.5; the UI offers the vault's bands: sedentary 1.3–1.4, light 1.4–1.55, moderate 1.55–1.7), `training_weekdays` (int[], ISO, default `[1,3,5]`), `weigh_in_reminders` (jsonb: days and time, default Mon/Thu 07:30), `enabled_modules` (text[]: just `scanner` and `ai_planner` in v1).

**`day_override`**: `date`, `day_type` (training · rest), `plan_weekday` (nullable: which plan day Today should show, e.g. move Monday's training menu to Tuesday). When there's no override, Today shows the plan day for today's weekday, with the day type from `training_weekdays`.

### 5.2 Body data

**`body_measurement`**: one row per scale reading.

| Field                                                                                                                                                      | Notes                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `measured_at`                                                                                                                                              | timestamptz (the CSV has local time with no zone, so it's interpreted in `profile.timezone`)                                                                                                             |
| `source`                                                                                                                                                   | `tanita_csv` · `manual` · `shortcut`                                                                                                                                                                     |
| `weight_kg`, `bmi`                                                                                                                                         |                                                                                                                                                                                                          |
| `body_fat_pct`, `muscle_mass_kg`, `muscle_quality`, `bone_mass_kg`, `visceral_fat`, `bmr_kcal_scale`, `metabolic_age`, `body_water_pct`, `physique_rating` | all nullable                                                                                                                                                                                             |
| `protocol_ok`                                                                                                                                              | bool: measured between 05:00 and 10:30 local time (the vault protocol is morning, fasted, after the bathroom). Off-protocol readings get half weight in the trend.                                       |
| `outlier`                                                                                                                                                  | bool, set by the trend fit (§6.1). Can be overridden by hand.                                                                                                                                            |
| `raw`                                                                                                                                                      | jsonb: the original row                                                                                                                                                                                  |
| dedupe                                                                                                                                                     | **unique (`user_id`, `measured_at` rounded to the minute)**, whatever the source. If a manual or Shortcut entry falls within ±10 min of a CSV reading, the CSV row wins and the other is merged into it. |

No segmental fields: the RD-953 export has them, but they're empty (`-`, or `0.00` for per-limb muscle quality) on every row. If they ever appear, they're kept in `raw`.

**`girth_measurement`**: `measured_on`, `waist_cm`, `chest_cm`, `biceps_cm`, `quad_cm`, `notes`.

**`checkin`**: the weekly check-in, one per ISO week.

- `week_start` (unique), `measurement_id` (nullable fk), `girth_id` (nullable fk)
- **`adherence`**: `on_plan` · `mostly` · `off`. **This is the decision gate.**
- **`training_progressed`**: `yes` · `no` · `deload`. The vault says to add food only if training actually escalated.
- `sleep`, `energy`, `hunger` (1–5), `notes`

### 5.3 Food

**`food`**: the catalogue.

| Field                                                                                              | Notes                                                                                                                                   |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `source`                                                                                           | `off` · `opennutrition` · `custom`                                                                                                      |
| `source_ref`, `barcode` (indexed), `name`, `brand`, `category`                                     |                                                                                                                                         |
| per 100 g/ml: `kcal`, `protein_g`, `carbs_g`, `sugar_g`, `fat_g`, `sat_fat_g`, `fibre_g`, `salt_g` |                                                                                                                                         |
| `basis`                                                                                            | `raw` · `dry` · `cooked` · `drained` · `as_sold`: what the per-100 values refer to                                                      |
| `units`                                                                                            | jsonb, named portions with their gram basis, e.g. `{"can": {"g": 240, "basis": "drained"}, "cup": {"g": 150}}`                          |
| `nutriscore_grade`, `nova_group`, `additives` (text[]), `ingredients_text`                         | from Open Food Facts                                                                                                                    |
| `label_source`, `captured_on`                                                                      | for custom foods                                                                                                                        |
| `version`                                                                                          | Increases on every change to nutrient values. The previous values are copied to `food_version` (append-only), so history never changes. |

**`pool_entry`**: the Food Pool. `food_id`, `type`, `macro_anchor`, `role` (main_protein · main_carb · fat · veg · fruit · dairy_protein · snack · other: **derived from type and anchor when the entry is created, and editable**), `preferred_slots` (text[]), `priority` (high · medium · low), `portion_rule` (flexible · fixed_unit), `planning_unit` (`{unit, step}`), `notes`, `active`.

### 5.4 Rules

**`rule`**: `kind`, `params` (jsonb), `text`, `scope` (`global`, or a `meal_plan_id` for rules that apply to one plan only), `active`.

| Kind                          | Example params                                                    | Source                                                                                                                   |
| ----------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `exclude_food`                | `{food_id}`                                                       | "No tofu" (Lean Surplus)                                                                                                 |
| `max_units_per_day`           | `{food_id, max: 2}`                                               | Greek yogurt ≤2 units/day                                                                                                |
| `not_same_day`                | `{foods: [huel_bar, huel_protein]}`                               | Huel rule                                                                                                                |
| `forbidden_on_day_type`       | `{food_id: potatoes, day_type: training}`                         | No potatoes on training days                                                                                             |
| `allowed_weekdays`            | `{food_id: eggs, weekdays: [1,2,3,4,5]}`                          | Eggs on weekdays only                                                                                                    |
| `min_portion_or_fallback`     | `{foods: [rice, pasta], min_g: 50, fallback: [rice_cakes, wasa]}` | <50 g rice/pasta → rice cakes or Wasa                                                                                    |
| `no_repeat_role_lunch_dinner` | `{roles: [main_protein, main_carb]}`                              | No repeating the main protein or carb in lunch and dinner                                                                |
| `fixed_slot`                  | `{slots: [breakfast, morning_snack, afternoon_snack]}`            | Breakfast, morning snack and afternoon snack options stay fixed                                                          |
| `fixed_portion`               | `{food_id: chicken, slot: dinner, g: 190}`                        | Chicken as the 190 g frozen slice at dinner                                                                              |
| `kcal_floor_per_day`          | `{phase: cut, min: 2000}`                                         | ≥2000 kcal on every cut day                                                                                              |
| `fibre_floor`                 | `{min_g: 20, pct_of_carbs: 10}`                                   | Fibre rule                                                                                                               |
| `veg_must_be_weighed`         | `{}`                                                              | Vegetables carry grams, so fibre is countable                                                                            |
| `guidance`                    | —                                                                 | Anything that can't be checked by code (2 fruit and 2 veg servings, front-load protein, etc.), sent to the model as text |

### 5.5 Phases, targets and plans

**`phase`**:

- `type`: cut · maintenance · surplus · maingain · recomp
- `started_on`, `ended_on`, `status`
- `rate_band` (kg/week, e.g. `[0.10, 0.20]`), `target_weight_kg` (maintenance/maingain), `hold_band_kg` (default ±0.5)
- `surplus_pct` / `deficit_rate_pct`, `review_every_days` (default 21), `intent`, `post_mortem`

**`maintenance_estimate`**: append-only. `as_of`, `kcal`, `method` (seed_observed · seed_mifflin · adaptive), `inputs` (jsonb), `ci_kcal` (±). Shown for information and used as the guardrail in §6.3.

**`targets`**: versioned. `phase_id`, `version`, `effective_from`, then per day type (`training`, `rest`): `kcal`, `protein_g`, `fat_g`, `carbs_g`, `fibre_g`. Plus `carb_change_g` (vs the previous version; drives the water grace period), `reasoning`, `created_by` (engine · manual).

**`meal_plan`**: `phase_id`, `targets_id`, `status` (draft · proposed · active · archived · rejected), `created_by` (ai · manual), `ai_run_id`, `summary`, `activated_at`.

**`plan_day`**: `meal_plan_id`, `weekday`, `day_type`, plus computed totals.

**`plan_meal`**: `plan_day_id`, `slot`, `position`, `notes`.

**`plan_option`**: `plan_meal_id`, `label`, `is_default`, plus the computed macro difference against the default.

**`plan_item`**: `plan_option_id`, `food_id`, `food_version`, `quantity_g`, `display_qty` + `display_unit`, `role` (copied from the pool entry), and **macro snapshot** fields (`kcal`, `p`, `c`, `f`, `fibre`), frozen when the plan is activated.

### 5.6 Adherence and logging

**`meal_check`** (optional detail): `date`, `plan_meal_id`, `status` (as_planned · swapped · skipped · partial), `fraction` (0–1, used with `partial`), `option_id`.

**`food_log`**: `date`, `slot`, `food_id`, `food_version`, `quantity_g`, `via` (scan · search · swap · quick_add), plus the **macro snapshot**.

**`daily_intake`** (a view): planned values, adjusted by any checks and logs. It's used for display and for the maintenance estimate, **never as a gate**.

### 5.7 AI and notifications

**`ai_run`**: `kind`, `model`, `prompt_version`, `input`, `raw_output`, `parsed_output`, `validation_errors`, `attempt`, `status`, `usage`, `cost_usd`, `duration_ms`.

**`proposal`**: `kind` (targets_change · new_plan · plan_revision), `payload`, `diff`, `reasoning`, `status` (pending · approved · rejected · expired), `decided_at`.

**`push_subscription`**: `endpoint`, `keys`, `device_label`.

---

## 6. The targets engine (plain code, no AI)

A pure, deterministic module (`packages/shared/engine`). It takes explicit inputs (`now` included) and returns numbers plus a reasoning trace. It's fully unit-tested on my real data (§14).

### 6.1 Weight trend

- **Input:** every non-outlier reading in the last **42 days** (extended to 56 if there are fewer than 4 readings). Off-protocol readings get half weight.
- **Water grace period:** if the active targets have `carb_change_g ≥ 40`, readings from the first 14 days after `effective_from` are left out. This matches the vault: "judge the true rate from week 2 onward".
- **Fit:** weighted least squares on `weight ~ days`, giving a `slope` in kg/week and its standard error. The SE uses a noise floor of σ = 0.6 kg per reading, so a few readings that happen to line up don't look precise.
- **Outliers:** after a first fit, any reading with |residual| > 3 × MAD (median absolute deviation) is flagged `outlier` and the fit is redone. The UI shows flagged points and lets me un-flag them. (2026-08-21's 85.60 kg is the reference case.)
- **Output:** `slope`, `ci80` = slope ± 1.28·SE, `n`, `span_days`, `latest_age_days`, `excluded`.
- **Readiness:** a trend is **decidable** only if `n ≥ 4`, `span_days ≥ 21` and `latest_age_days ≤ 10`. Otherwise every rule holds, with the reason "need more weigh-ins" plus how many more and by when.

Why this matters: at my real cadence (one reading every 2–4 weeks), a 0.10–0.20 kg/week band can't be resolved, and the app will say so plainly. With σ = 0.6 kg, the CI80 half-width is about:

- **±0.13 kg/week** at 2 readings a week over 6 weeks
- **±0.08** at 2 a week over 8 weeks
- **±0.07** with daily readings over 6 weeks

That's enough to detect "clearly flat" or "clearly too fast", which is what the rules act on. It isn't enough to fine-tune _inside_ the band, and the engine doesn't try to. The reminders in §10 exist to get to at least 2 readings a week. Daily is better if I'm willing.

### 6.2 Maintenance estimate (information and guardrail only)

- **Seed:** observed (the vault's ~2040, imported as `seed_observed`). If there's no observed value, Mifflin-St Jeor × `activity_factor` (the vault's method). Katch-McArdle from Tanita lean mass is **shown alongside for comparison only**.
- **Update at each review** (only if the trend is decidable and the check-in adherence for the window is mostly `on_plan`/`mostly`):

  ```
  observed_tdee = mean(daily_intake over window) − slope_kg_per_week × E / 7
  E = 7700 kcal/kg when losing, 5500 kcal/kg when gaining   # gain is part lean tissue; both configurable
  estimate      = 0.6 × previous + 0.4 × observed_tdee, clamped to previous ± 150
  ```

- `daily_intake` defaults to the plan's values. This is the vault's own reasoning ("ate the plan, weight flat, so that's maintenance"), and the reasoning trace says so.
- **It never changes targets.** It is used for: (a) setting the starting targets of a _new_ phase, and (b) the guardrail in §6.3.

### 6.3 Phase targets (only when a new phase starts)

| Phase                  | Average kcal                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| cut                    | maintenance − deficit, deficit = `rate (%BW/week) × BW × 7700 / 7` (default 0.5%/week)                        |
| maintenance / maingain | maintenance                                                                                                   |
| recomp                 | maintenance; training +150 / rest −150                                                                        |
| surplus                | maintenance × (1 + `surplus_pct`), default 10% (the top of the vault's 5–10% band, as the current plan chose) |

**Cut floor, applied per day:** each day's kcal must be ≥ 2000. If the floor binds, the engine reports the **rate it can actually achieve** ("the floor limits this cut to ~0.05%/week") and asks me to confirm, suggesting activity as the lever. It doesn't silently produce a cut that isn't one; that's how the Cut to 11% failed.

**Macros** (set in this order, based on the weekly average):

1. **Protein:** g/kg by phase (cut 2.0 · surplus 1.9 · maintenance 1.8 · recomp 2.1). It's a floor. It changes only when a phase starts (the vault deliberately went from 178 to 165 between phases).
2. **Fat:** 0.85 g/kg, kept at ≥0.7 g/kg and, in a surplus, within 20–30% of the **weekly-average** kcal. The same grams are used on every day type.
3. **Carbs:** the remainder ÷ 4.
4. **Fibre:** max(20, 10% of carbs).

**Training vs rest split** (the weekly average is unchanged; the difference is all carbs):

```
training_kcal = avg + Δ × rest_days/7      rest_kcal = avg − Δ × training_days/7      Δ default 120
```

Check: maintenance 2040 × 1.10 = 2244 average → training ≈ 2313, rest ≈ 2193. The current plan's 2320/2200 is the same within rounding.

**Guardrail:** after any change, a surplus can't go above maintenance × 1.10, and a cut can't go below the floor. A proposal that would break either is capped, and the cap is explained.

### 6.4 Review rules (the only thing that changes targets)

They run every `phase.review_every_days`, or when I ask for one. **Gates, all of which must pass:**

- the trend is decidable (§6.1)
- the most recent ≥2 check-ins have `adherence` of `on_plan` or `mostly`
- the window isn't inside the water grace period

Otherwise the result is "hold", with the specific reason and what would unblock it.

**Change semantics:** "+150 kcal" means **+150 kcal on each affected day**. A "training days only" step is about +64 kcal/day on the weekly average, and the UI shows both figures. All changes are carbs only.

| Phase                  | Condition (uses the slope's CI80)                                                                         | Action                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| surplus                | CI80 entirely above 0.25 kg/week, **or** waist up >1 cm over the window                                   | −100 kcal carbs, **rest days first**                                  |
| surplus                | CI80 entirely below the band's lower edge **and** `training_progressed = yes`                             | +150 kcal carbs (training days only if within 150 of the guardrail)   |
| surplus                | below the band but `training_progressed = no`                                                             | hold: "fix the training stimulus first; more food would only add fat" |
| surplus                | low recovery (sleep/energy ≤2) for 2 check-ins                                                            | no calorie change; show the sleep advice                              |
| cut                    | CI80 entirely below 0.5% BW/week of loss (too slow, flat included)                                        | −100 kcal carbs on rest days (partial-week step)                      |
| cut                    | CI80 entirely above 1% BW/week                                                                            | +150 kcal carbs on training days                                      |
| cut                    | low recovery for 2 check-ins                                                                              | +100 kcal carbs on training days                                      |
| cut                    | 12+ weeks in the phase                                                                                    | propose a 2-week diet break at maintenance (a proposal only)          |
| maintenance / maingain | trend projects outside `target_weight ± hold_band` and the slope over the last 14 days is >0.5 kg/week up | −100 kcal carbs                                                       |
| maintenance / maingain | same, but >0.3 kg/week down                                                                               | +100 kcal carbs on training days                                      |
| maintenance / maingain | low recovery for 2 check-ins at stable weight                                                             | +100 kcal carbs on training days                                      |
| any                    | otherwise                                                                                                 | hold, "on target"                                                     |

The output is a `proposal` (`targets_change`) with the trace. If I approve it, the engine re-checks the current plan against the new targets and offers either "adjust portions" (the solver only, no AI) or "generate a new plan".

---

## 7. The meal-plan AI pipeline

**Data assembly → prompt → structured output → validate → portion solver → repair only the failing days → proposal.** Nothing reaches the active plan without passing the validator and my approval.

### 7.1 Model and API

- Model **`claude-opus-5-5`** via `@anthropic-ai/sdk`, adaptive thinking, `output_config.effort: "high"`. The model can be set in `.env`.
- **Structured outputs:** `client.messages.parse()` + `zodOutputFormat(PlanSchema)`. Constraints the schema can't express (e.g. exactly 7 days) are enforced by the validator.
- **Refusal fallback:** server-side `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`). `stop_reason` is checked before reading content. Both are to be confirmed against the live API docs at build time.
- **Prompt caching:** the static system prompt is cached. That mainly helps the repair round, since full generations are about a week apart.
- Streaming with `finalMessage()`, run in the pg-boss worker. The UI polls the job status.
- **Estimated cost:** about $0.25–0.35 per plan, and about double with a repair. Under $3/month. The actual cost of each run is logged and shown in Settings.

### 7.2 Payload (an allowlist; nothing is passed through unfiltered)

`targets` (training and rest) · `week` (weekday → day type) · `slots` · `fixed_slots` (the items and options of the fixed slots, already filled in) · `pool` (with `role`, `basis`, per-100 values, `units`, `notes`) · `rules` (structured + guidance) · `previous_plan` (summary + foods per slot) · `preferences.free_text` (optional, ≤500 chars, in a delimited user block).

### 7.3 Output contract (Zod, simplified)

```ts
Plan = {
  summary: string,                                // ≤ 600 chars
  days: Array<{ weekday: 1..7,
    meals: Array<{ slot: Slot, notes?: string,
      options: Array<{ label: string, is_default: boolean,
        items: Array<{ food_id: string, qty: number, unit: string }> }> }> }>
}
```

The model only names foods and amounts. **Roles, macros and totals are all computed in code.**

### 7.4 Validator

It collects every error and never stops at the first:

1. **Shape:** 7 days, all non-fixed slots present, exactly one default option per meal.
2. **References:** every food is in the active pool and not excluded. Units exist for the food.
3. **Portion rules:** fixed units are whole numbers; flexible portions are multiples of their step.
4. **Structured rules** (§5.4), checked per day, including `veg_must_be_weighed`.
5. **Macros**, recomputed for each day's default options, against that day type's targets. The tolerances are **calibrated on the current Lean Surplus plan, which must pass**:
   - kcal ±3%
   - protein ≥ target − 5 g (and ≤ target + 25 g)
   - fat within ±10 g
   - carbs ±8%
   - fibre ≥ target (only if every veg is weighed)
6. **Variety:** no lunch/dinner pairing more than 2× a week.
7. **Option differences:** computed and stored. Not blocking, unless an option breaks a structured rule.

**Golden test:** the Lean Surplus plan, entered as a plan (Mon 2327/173/247/71 … Sun 2206/179/213/70), passes against its targets (165 P, 75 F). Tue P164, Thu F66 and Sat F67 are all inside the calibrated tolerances.

### 7.5 Portion solver

- **For each day** that fails only on macros: a **small integer program**. The variables are step counts for the flexible items, each within ±30% of the model's quantity.
- **Constraints:**
  - protein ≥ floor
  - fibre ≥ floor
  - fat within ±10 g
  - kcal within ±3%
  - `min_portion` rules
- **Objective:** minimise weighted deviation from the kcal and carb targets, plus a small penalty for each change.
- **Then every rule is re-run.** A solver result that breaks a rule is thrown away.
- The solver's changes are recorded in the proposal ("Day 3: rice 80→90 g").
- The same solver serves "adjust portions to the new targets" after a targets change (§6.4), with no AI call.

### 7.6 Repair and failure

- If days still fail: **one repair round, for the failing days only.** The days that passed are sent along as fixed context, with the numbered errors for the failing ones.
- If the repair fails: the run is marked `failed`, and the errors are shown with "Retry" and "Edit manually". A half-valid plan is never proposed.

### 7.7 Proposal and approval

- A week grid with totals against targets, a diff against the active plan, the summary, and the solver's changes.
- **Approve:** the old plan is archived and the new one activated, with macro snapshots frozen. **Reject:** optional feedback, which goes into the next run's `preferences`.
- **Manual editing** of any item. Totals recompute live, and rule breaks are flagged without blocking.

### 7.8 Review narrative (optional)

A small call (`effort: "medium"`) turns the engine's trace (§6.4) into a short explanation in the vault's tone. It takes the decision as input, so it **explains the decision and can't change it**.

---

## 8. Getting body data in

### 8.1 Tanita RD-953 CSV (format confirmed from a real export, 2026-11-05)

- Header: `Date,"Weight (kg)",BMI,"Body Fat (%)","Visc Fat","Muscle Mass (kg)","Muscle Quality","Bone Mass (kg)","BMR (kcal)","Metab Age","Body Water (%)","Physique Rating"`, then 15 segmental columns and `"Heart rate"`.
- `Date` is `YYYY-MM-DD HH:MM:SS` local time. Decimals use `.`. Missing values are `-`. The segmental "Muscle quality" columns show `0.00` when missing.
- The parser matches columns by header name (an alias table, so a future Italian-language export or reordered columns still work). `-` becomes null, as do per-limb muscle-quality `0.00`s.
- **Preview** shows new rows, duplicates (§5.2 dedupe) and invalid rows. Importing the same file twice changes nothing.
- My export has 38 readings, 2025-01-28 → 2026-11-02. It matches the vault log row for row through 2026-10-05, and adds **2026-11-02 86.75 kg**.

### 8.2 Upload paths

- **In the app:** Progress → Import → choose file. This is the basic path, and it always works.
- **iOS Shortcut "Send to Diet Planner":** accepts the CSV from the share sheet and POSTs it to `/api/ingest/tanita` with the ingest token. (iOS doesn't let installed web apps receive files from the share sheet, so this replaces that.) After an import, a push notification links straight to the preview.

### 8.3 Fast weigh-in and waist

- **iOS Shortcut "Log weight":** asks for a number, POSTs it to `/api/ingest/weight`, done in about 5 seconds. It's stored as `source: shortcut` and merged if a Tanita row arrives later for the same minute range.
- In the app, the check-in starts with the weight input focused.
- Waist is entered in the check-in (tape measure, at the navel).

---

## 9. Barcode scanning and scoring

### 9.1 Lookup chain

1. Local `food` by barcode.
2. **Open Food Facts** API v2 (fields-limited request, generic user agent `DietPlanner/0.1 (self-hosted)`, no personal data). The result is cached as a `food`.
3. Not found → **label capture:** photograph the label → Claude vision extracts the per-100 values as structured output → I review and correct them → saved as a `custom` food. EXIF data is stripped, and the photo is deleted after extraction unless I keep it.

Generic foods are found by text search over the local catalogue (pool foods first).

### 9.2 Scores

These are my own scores, shown with their parts. No Yuka branding or formula.

**Quality, 0–100** (general):

- Nutritional quality, 60%: the Open Food Facts Nutri-Score grade (A=100 … E=0), otherwise computed from nutrients with the published Nutri-Score algorithm.
- Processing, 25%: NOVA 1=100, 2=75, 3=50, 4=15.
- Additives, 15%: 100 − 15 per additive, floor 0.
- **Missing parts:** the weights are spread over the parts that are present. With only one part available, the score shows as "partial" and isn't banded.
- Bands: ≥75 good · 50–74 OK · 25–49 poor · <25 avoid.

**Fit for me, 0–100: weighted by the current phase and day**

| Component                                                         | Cut | Maintenance | Surplus |
| ----------------------------------------------------------------- | --: | ----------: | ------: |
| Protein density (g P per 100 kcal vs 10 g)                        | 40% |         30% |     20% |
| Fits today's remaining kcal/fat budget (a typical portion)        | 30% |         30% |     15% |
| Helps close today's kcal _gap_ (energy density when under target) |  0% |         10% |     35% |
| Slot fit (matches pool types for the current/next slot)           | 15% |         15% |     15% |
| No rule conflicts today                                           | 15% |         15% |     15% |

Result sheet: both scores with their parts, macros per 100 g and per typical portion, the reasons, and then **"Ate it" (grams) / "Add to pool" / "Close"**.

---

## 10. Reminders (the cadence fix)

Web push to the installed app (iOS 16.4+). A once-a-minute check in the app process sends them, and a `notification_log` row per kind and day keeps each one to a single send, across restarts too:

| When                                                | Message                                                       | Opens                                      |
| --------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------ |
| Weigh-in days (default **Mon + Thu 07:30**)         | "Weigh-in: Tanita, then share the CSV, or tap to log weight"  | The check-in, or the "Log weight" Shortcut |
| Monday 20:00, if this week's check-in is incomplete | "Check-in: 4 taps (adherence, training, waist, how you feel)" | The check-in                               |
| When the trend isn't decidable                      | "Trend needs 2 more weigh-ins before the review on 12/03"     | Progress                                   |
| Review due                                          | "Review ready: proposal waiting"                              | Proposal                                   |

Reminders are quiet: at most one per day, and none when the task is already done.

---

## 11. Screens

Phone-first, with a bottom tab bar: **Today · Plan · Scan · Progress**. Settings sits in a header menu.

| Screen           | What it does                                                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Today**        | Training/rest badge. Today's meals with the option switcher (S1/S2/S3 with macro differences). Optional one-tap meal checks. A check-in banner when one is due.                                                          |
| **Check-in**     | Weight (focused on open, or prefilled from today's import) → waist → adherence (on plan / mostly / off) → training progressed (yes / no / deload) → sleep/energy/hunger. Under 60 s.                                     |
| **Plan**         | Week grid with totals against targets, the targets and their reasoning, phase info, the next review and its readiness ("needs 2 more weigh-ins"). A proposals inbox. Generate a new plan. Manual edit mode.              |
| **Scan**         | Camera, the result sheet, "search instead".                                                                                                                                                                              |
| **Progress**     | Weight chart (points with outliers marked, the trend line with its CI band, the target-rate band), waist and girths, BF%/MM charts labelled "trend only", maintenance-estimate history, phase timeline and post-mortems. |
| **Food library** | Pool, custom foods, rules.                                                                                                                                                                                               |
| **Settings**     | Profile, training weekdays, reminders, Shortcut setup and token, AI model and cost, imports/exports.                                                                                                                     |

Design notes: dark and light themes, large touch targets, undo toasts instead of confirmation dialogs, numbers in tabular figures.

---

## 12. Seeding (a one-off, kept small)

| Data                           | How                                                                                                                                                                                                                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Body measurements              | **The Tanita CSV only** (§8.1). The vault log is the same data.                                                                                                                                                                                                   |
| Food Pool                      | `scripts/import-food-pool.ts`, given the vault path: parses the Food Pool table into `pool_entry`. Foods are resolved from `Huel Products.md`, then Open Food Facts search, otherwise left as `custom` stubs to fill in. It prints a report of what's unresolved. |
| Rules                          | Entered by hand in the rules editor, from §5.4's table (about 13 rules). That's quicker and more accurate than parsing prose.                                                                                                                                     |
| Active phase, targets and plan | Entered by hand: the Lean Surplus phase from 2026-08-24, targets 2320/2200 · 165 P · 75 F, and the 7-day plan through the plan editor. This also tests the editor, and the plan doubles as the golden validator test (§7.4).                                      |
| Maintenance seed               | 2040, `seed_observed`, dated 2026-08-24.                                                                                                                                                                                                                          |
| Past phases                    | Optional: name, dates, type and a post-mortem link for the timeline, entered by hand.                                                                                                                                                                             |

The OpenNutrition catalogue import is **deferred**. The licence and format need checking, and Open Food Facts plus the pool covers v1.

---

## 13. Security and privacy

- v1 is reachable only over Tailscale. No public ports apart from what Tailscale itself needs.
- The ingest endpoints need the bearer token, are rate-limited, and only accept the expected CSV columns and size (≤1 MB).
- The Anthropic key lives only in the server environment. Only allowlisted fields go into AI payloads. Free text is length-capped and kept out of the system prompt.
- Open Food Facts requests carry no personal data.
- Label photos have EXIF stripped and are deleted by default.
- Backups are encrypted (restic) and kept off-site, with a monthly restore test.

---

## 14. Testing

- **Engine, using my real CSV as fixtures:**
  - The trend over 2026-09-16 → 2026-11-02 (3 readings) is **not decidable**, with the reason "need ≥4 readings".
  - Synthetic 2×/week series at known slopes recover the slope within the CI.
  - The 08-21 reading is flagged as an outlier in a window that includes it.
  - Each row of the decision table fires on a synthetic series built for it, and stays on "hold" when its CI straddles the band.
  - The water grace period excludes days 0–13 after a carb change of +40 g or more.
  - Maintenance update: a synthetic series with a flat slope and 2040 intake gives an observed TDEE of 2040, so the estimate moves towards 2040 from a seed of 2100. A positive slope reduces it by slope × 5500/7.
  - Phase targets: maintenance 2040, surplus 10% → about 2244 average, about 2313/2193 for training/rest.
  - Cut floor: maintenance 2040 at 0.5%/week → the floor binds and the achievable rate is reported.
- **Validator and solver:** the Lean Surplus golden plan passes. Broken plans (excluded food, eggs on Saturday, macro off by 5%, rice at 45 g) produce exactly the expected errors. The solver fixes portion-only misses and never breaks a rule.
- **Importers:** the real CSV, importing it twice, the dedupe between a Shortcut weight and the CSV.
- **AI:** the model is mocked in CI. A manual `pnpm eval:plan` reports validator pass rate, repair rate and cost.
- **End to end (Playwright):** a check-in, a CSV import, approving a proposal, a meal check.

---

## 15. Milestones

| #      | Scope                                                                                                                                             | Done when                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **M0** | Repo, compose on the VM behind Tailscale with HTTPS, DB migrations, CI (lint, typecheck, tests), backups with an off-site copy and a restore test | The installed app opens on my phone over Tailscale                                                           |
| **M1** | Tanita CSV import (app + Shortcut), "Log weight" Shortcut, check-in, push reminders, Progress (trend with CI, outliers, waist)                    | My history is in, and I've had a week of reminders and weigh-ins through the app                             |
| **M2** | Targets engine, phase, targets and plan entered by hand, Today, review proposals                                                                  | **The first review after 3 weeks of app-captured weigh-ins** runs in the app and produces a decidable result |
| **M3** | AI plan generation: payload, validator, solver, repair of failing days, proposals, manual editing, `eval:plan`                                    | ≥90% of `eval:plan` runs give a valid week; the golden plan passes                                           |
| **M4** | Scanner, Open Food Facts, label capture, scores, food logging                                                                                     | Scan → score → "ate it" in under 10 s                                                                        |
| v2     | Grocery list, vault export, passkeys and public access, OpenNutrition catalogue, additive risk table, integrations                                | —                                                                                                            |

**The 2026-11-16 review happens in the vault, as planned.** The app wouldn't have the data to run it: there's no weigh-in after 11-02, and per-reading noise is larger than the target band. The app's job is to make the _next_ review decidable.

---

## 16. Open questions

1. ~~Tailscale-only access for v1~~: **decided**, Tailscale for v1, to be revisited later.
2. **Weigh-in cadence:** are the default reminders (Mon + Thu mornings) right? Twice a week is the minimum for a decidable trend in about 6 weeks. Daily morning weigh-ins would tighten it noticeably. The "Log weight" Shortcut makes daily realistic, with the Tanita CSV only for the full composition reading.
3. ~~Off-site backup target~~: **decided**, Oracle Cloud Object Storage (S3-compatible API), or any other S3 bucket.
4. **After the switch:** does the vault stay the record for diet _reasoning_ (Galaxy notes, post-mortems), with the app holding the numbers? My recommendation is yes.
5. **Gain energy density:** keep 5500 kcal/kg for the maintenance estimate during a surplus (vs 7700 for loss)? It only affects the information-only estimate.

---

## 17. Changes from v1

| Area           | Change                                                                                                                                                                            | Why                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Trend          | Every reading, a robust WLS with a CI, outlier flagging; rules fire only when the CI clears the band; a hard hold on stale data                                                   | Weekly single readings are noisier than the 0.10–0.20 band (review B1)             |
| Control        | The decision table is the only controller; maintenance is information and a guardrail; surplus capped at +10%                                                                     | Two controllers double-counted corrections (B2)                                    |
| Gating         | A weekly adherence answer replaces meal-check coverage                                                                                                                            | The coverage gate depended on the habit that had failed (B3)                       |
| Validator      | Tolerances calibrated so the current plan passes; vegetables must be weighed; golden test                                                                                         | v1 tolerances rejected the working plan (B4, verified: Tue P164, Thu F66, Sat F67) |
| Decision table | Matches the vault: >0.25 kg/week or waist +1 cm, rest days first; training-progressed gate; sleep-first in surplus; cut "too slow" row; maintenance target weight; "+150" defined | Inconsistent with the vault rules                                                  |
| Cut floor      | Per day; the achievable rate is reported                                                                                                                                          | The floor silently cancelled cuts                                                  |
| Rules          | No tofu, eggs weekdays only, 190 g chicken slice, fixed afternoon snack, exclusions, veg weighed                                                                                  | Missing plan-level vault rules                                                     |
| Roles          | Derived in code from the pool                                                                                                                                                     | The AI labelled roles that the validator then trusted                              |
| Solver         | Integer program with floors, then all rules re-run                                                                                                                                | A greedy squared-error search can't express floors                                 |
| Data model     | Macro snapshots + food versions; dedupe across sources; timezone; `partial` fraction; `day_override.plan_weekday`; text + CHECK; `basis` units                                    | History could be rewritten silently                                                |
| Fit score      | Weighted by phase (energy density counts in a surplus)                                                                                                                            | Protein-heavy weighting fought the surplus                                         |
| Access         | Tailscale-only v1 with an ingest token; passkeys moved to v2 with a setup token                                                                                                   | "First visitor registers" was claimable; less M0 work                              |
| Ops            | Off-site encrypted backups + monthly restore test                                                                                                                                 | Backups lived on the same VM                                                       |
| Input          | Shortcut-based CSV and weight ingest, web push reminders                                                                                                                          | iOS share-to-web-app doesn't exist; cadence needed pushing                         |
| CSV            | Real format documented; segmental fields dropped; `muscle_quality` and `bmi` added; protocol (morning) flag; vault log import dropped                                             | From the real export                                                               |
| Seeding        | Rules, phase and plan entered by hand; OpenNutrition deferred                                                                                                                     | Parsing vault prose isn't worth it for about 30 items                              |
| Scope          | M1 = cadence (import, Shortcut, reminders, check-in); 11-16 review stays in the vault                                                                                             | The real failure is adherence and cadence                                          |
| Formulas       | Mifflin + the vault's activity bands primary; Katch for comparison only; 7700/5500 by direction                                                                                   | Matches the vault method; gain is part lean tissue                                 |
