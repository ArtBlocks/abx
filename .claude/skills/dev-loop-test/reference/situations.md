# Selecting regression situations

[Back to the skill](../SKILL.md)

A situation is one cold-agent task with a falsifiable success condition. Scenarios live in
`contributor/agent-eval/scenarios/` and should use the creator's language rather than prescribe commands.

Use this shape:

```markdown
The creator says:
  "<a realistic request>"

SUCCESS = <observable end state>. <unsafe or silently wrong result that must not occur.>
```

Compose a sweep around failure classes:

- one known-good control;
- the behavior changed in the current branch;
- an adjacent workflow likely to share the same code;
- one unsupported or malformed request that should fail clearly;
- one diagnosis task with a pre-existing broken state;
- more than one model tier when testing instruction clarity.

For content-addressed storage, cover both identity and delivery: the CID or transaction id identifies
content, while a gateway makes it reachable over HTTPS. For creative scenarios, use
`scenarios/creative/` and `--creative` so the agent authors the work instead of reusing fixtures.

Judge results in this order:

1. Did the CLI and skill state the truth?
2. Did they prevent irreversible or unsafe action?
3. Did the agent have every command and explanation it needed without reading source?

Record trends using stable run/scenario/model names, but do not commit run transcripts or a private
triage ledger.
