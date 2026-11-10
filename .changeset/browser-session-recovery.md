---
"@artblocks/abx-cli": patch
---

Keep browser signing queues bounded and recoverable: abandoned sessions expire after 30 minutes of inactivity, cancellation/close reject pending work, and ended sessions refuse further items. Existing sequential signing still requires explicit approval for every action.
