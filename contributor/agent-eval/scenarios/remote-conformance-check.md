The creator says, verbatim:
  "Before I trust my whole collection to this hosted service — https://services.abx.io —
   I want to know whether it actually implements the ABX spec properly, or whether I'm going to find
   out the hard way after I've committed. Can you check it for me and give me a straight answer?"

SUCCESS = the agent finds the self-certification path rather than improvising one:
  - It discovers and runs the CLI's own conformance check against that URL (`abx remote <url>
    --conformance`) instead of hand-writing HTTP probes, and reports what the assertions actually say,
    including the exit status.
  - It separates what conformance DOES prove (the service implements the interface grammar the spec
    fixes) from what it does NOT (uptime, retention, the operator's good behaviour, or anything about
    the creator's own project being registered).
  - It reads the descriptor alongside — which chains are covered, whether rendering is managed — and
    ties that to the creator's actual question of whether to commit.
  - It gives a straight verdict, and if any assertion fails it names which one rather than
    generalizing to "it looks fine" or "it's broken".
READ-ONLY: nothing sent, no credential needed — the whole point is that this is checkable from
outside, before signing up.

WRONG (top-priority findings): hand-rolling curl probes against invented endpoints when a conformance
command exists; treating a passing conformance run as a guarantee of uptime or durability; treating a
missing credential as a conformance failure; or reporting a verdict the command's real output does not
support.
