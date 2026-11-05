# OKF tabs show whether the knowledge base is worth reading

- The OKF tabs now measure value, not just access: pointer yield, code searched after reading an article, routing misses (agents that searched an article's area without opening it), dead pointers and catalog articles.
- A new article drill-down on the repo OKF tab shows these signals per article, with a suggested action for each finding.
- Reads by an agent that edits the article are shown separately as upkeep, section reads are marked, and stale or removed articles are flagged.
- The session OKF tab separates verified navigation checks (each rule with its threshold and result) from heuristic value signals, and an agent trail shows step by step what an agent read, which code paths it followed and what it searched afterwards, so the signals can be checked by hand.
- Agents are labelled by their task description instead of raw ids, and unread articles are grouped out of the way.
- OKF thresholds can be tuned per repository in Settings → Analysis without a recompute, and a banner offers to recompute sessions that have no OKF analysis yet.
