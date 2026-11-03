// Decide which model and effort a delegated job may run with. Every agent
// adapter resolves names its own way (Cursor folds effort into the model id,
// Codex takes it as a config value); the user's allow/deny/lock rules are
// applied here, the same way for all of them.
//
// A job that cannot get an allowed model does not start. There is no silent
// fallback to a different model.

import { die, globRe, matchesAny } from "./util.mjs";
import { policyFor } from "./config.mjs";

export function resolveModel(adapter, { requested = null, effort = null } = {}) {
  const pol = policyFor(adapter.name);
  const notes = [];
  const label = adapter.label;
  if (!pol.enabled) die(`${label} is turned off as a sub-agent (policy: enabled=false). Change it with: switchboard policy set ${adapter.name} enabled true`);

  if (requested && !pol.chooseModel && requested !== pol.model)
    die(`the user locked ${label}'s model to ${pol.model ? `"${pol.model}"` : "its own default"}; do not pass --model.${pol.chooseEffort ? " You may still choose --effort." : ""}`);
  if (effort && !pol.chooseEffort && effort !== pol.effort)
    die(`the user locked ${label}'s effort to ${pol.effort ? `"${pol.effort}"` : "its default"}; do not pass --effort.`);
  if (effort && pol.efforts.length && !pol.efforts.includes(effort))
    die(`effort "${effort}" is not allowed for ${label}; allowed: ${pol.efforts.join(", ")}`);

  const want = requested || pol.model || null;
  const eff = effort || pol.effort || null;
  if (eff && adapter.efforts && !adapter.efforts.includes(eff))
    die(`${label} effort must be one of ${adapter.efforts.join(", ")} (got "${eff}")`);

  if (!want) {
    // With no model named, the agent runs its own default, which Switchboard
    // can only check if the agent reports a concrete id at startup.
    if (pol.allow.length || (pol.deny.length && !adapter.verifiesModel))
      die(`${label} has an ${pol.allow.length ? "allow" : "deny"} list but no default model, so its own default could be one the list rules out. Set one: switchboard policy set ${adapter.name} model <id>`);
    // Still refuse an effort the agent's own default model does not offer.
    const def = eff && adapter.defaultModel?.();
    if (def) adapter.resolveModel(def, eff, { notes: [] });
    return { id: null, effort: eff, notes, requested: null };
  }

  const r = adapter.resolveModel(want, eff, { notes });
  if ((adapter.opaqueModels || []).includes(r.id) && (pol.allow.length || pol.deny.length))
    die(`${label}'s "${r.id}" picks a model by itself, so it cannot be checked against the user's allow/deny list. Name a model instead.`);
  checkModelAllowed(adapter, r.id, want);
  return { id: r.id, effort: r.effort ?? eff, notes, requested: want };
}

// Also called after a job starts, with the model the agent actually reported:
// an alias such as Claude's "sonnet" only becomes a concrete model at runtime.
// At that point only the reported model counts; the alias that was asked for
// must not satisfy the allow list on its behalf.
export function checkModelAllowed(adapter, id, requested = null, { runtime = false } = {}) {
  const pol = policyFor(adapter.name);
  const names = [...new Set([runtime ? null : requested, ...(id ? adapter.matchNames(id) : [])].filter(Boolean))];
  const blocked = names.find((n) => matchesAny(n, pol.deny));
  if (blocked) die(`${adapter.label} model "${id || requested}" is blocked by the user's deny list (${pol.deny.join(", ")})`);
  if (!pol.allow.length) return;
  const ok = pol.allow.some((pat) =>
    /:latest$/.test(pat) ? adapter.isLatestOf(pat, id) : names.some((n) => globRe(pat).test(n)),
  );
  if (!ok) die(`${adapter.label} model "${id || requested}" is not in the user's allow list (${pol.allow.join(", ")})`);
}

// Human-readable summary for doctor / policy show.
export function describePolicy(adapter) {
  const p = policyFor(adapter.name);
  const bits = [];
  bits.push(p.enabled ? "usable as sub-agent" : "OFF as sub-agent");
  bits.push(`model=${p.model || "(agent default)"}`);
  bits.push(`effort=${p.effort || "(default)"}`);
  bits.push(`orchestrator picks model: ${p.chooseModel ? "yes" : "no"}`);
  bits.push(`picks effort: ${p.chooseEffort ? "yes" : "no"}`);
  if (p.allow.length) bits.push(`allow=${p.allow.join(",")}`);
  if (p.deny.length) bits.push(`deny=${p.deny.join(",")}`);
  if (p.efforts.length) bits.push(`efforts=${p.efforts.join(",")}`);
  return bits.join("  ");
}
