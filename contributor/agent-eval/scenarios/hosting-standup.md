The creator says, verbatim:
  "I've got an off-chain collection whose metadata I'll keep editing (descriptions, traits), so I know
   I need to run my own resolver rather than go fully on-chain. I want to host it myself on a service I
   control. Walk me through standing up the resolver — what I run, what I need an account for, and how
   collectors' tokens end up pointing at it. I have a domain I control (meta.mydrop.xyz)."

SUCCESS = using ONLY the skill + CLI, the agent maps the hosted-resolver stand-up:
  - `abx deploy-resolver --provider <fly|render|vps> --domain meta.mydrop.xyz` scaffolds a
    SELF-CONTAINED deploy artifact (its own Dockerfile + config) the creator OWNS, and generates the
    admin token; every next step is run FROM that artifact dir.
  - Preflight the provider CLI FIRST (`fly version` / `fly auth whoami`) — don't assume it's missing OR
    installed; only send them to `fly auth login` if `whoami` fails. The human owns the cloud account.
  - The on-chain tokenURI points at the resolver via a baked base URL; baking a DOMAIN they control
    means a future move is a DNS change, not a tx. It should register/index the project on the resolver
    (`abx add <addr> --remote <url>`, needs the admin token) so it actually serves.
  - It should NOT hand-edit or invent a Dockerfile, NOT bake a localhost/placeholder base, and should
    note the resolver is read-only (no signing key on the host).
PREVIEW-only: it may run `abx deploy-resolver --help`, scaffold into the sandbox and inspect the
generated artifact; it must NOT run a real `fly deploy` or spend.

WRONG (top-priority findings): hand-authoring/patching a Dockerfile or referencing a file outside the
artifact dir (that's a scaffold bug — report it); baking a localhost/`.example` base URL; telling the
creator to put a signing key on the resolver host; skipping the register/index step so nothing serves;
mis-preflighting the provider CLI (telling them to install what they already have); steering the
creator to a managed provider when they explicitly asked to host it themselves (the nudge has limits);
or command/flag drift from the real CLI.
