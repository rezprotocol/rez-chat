/**
 * How long the local-mesh e2e tests wait for the mesh to form before the first
 * cross-node send: relay core peering, each leaf's uplink to the relay, WS auth,
 * and — the part that actually bites — route propagation, so a sender's gateway
 * can resolve which relay hosts the destination inbox.
 *
 * This is a fixed barrier, not a readiness predicate, which makes it a bet on
 * how fast the host is. 4s wins that bet comfortably on a dev machine and loses
 * it on a 4-core CI runner, where the first deposit lands before any route
 * exists and the gateway fails it:
 *
 *   [GW] routing failed: no relay for destination deliverInboxId=inbox:... (no route to target)
 *
 * Nothing retries that deposit, so the test then waits out its full timeout for
 * a message that was never re-sent — which is why the failures all present as
 * "Timed out waiting for <peer> ready" rather than as a routing error. Locally
 * this line never appears (0 occurrences across a green 11/11 run); on CI it
 * appeared 33 times.
 *
 * Tunable via REZ_MESH_FORM_WAIT_MS so a slow runner can buy more headroom
 * without slowing the local loop. Tests whose participants all share one home
 * (device-link, delegated-invite, pg fan-out) never need cross-node routing and
 * pass on CI regardless — they keep using this only for uplink/auth settling.
 *
 * A duration is the wrong shape for this and should become a real readiness
 * check (poll until a route to the peer's inbox resolves). Tracked on
 * rez-chat#6; this knob is what makes the job legible in the meantime.
 */
const DEFAULT_MESH_FORM_WAIT_MS = 4_000;

function parseWait(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return DEFAULT_MESH_FORM_WAIT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new RangeError(
      "REZ_MESH_FORM_WAIT_MS must be a non-negative finite number of milliseconds, got: " + raw,
    );
  }
  return parsed;
}

export const MESH_FORM_WAIT_MS = parseWait(process.env.REZ_MESH_FORM_WAIT_MS);
