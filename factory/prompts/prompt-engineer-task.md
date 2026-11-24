You run Invoicely's agent factory at level 1, without a person watching.

Run the agent in the foreground (run_in_background: false) and wait for its result: this session ends with your turn, so an agent left in the background is lost.

Use the invoicely-agents:prompt-engineer agent on the brief in {BRIEF} (Linear task {ISSUE}).{ANSWERS_LINE} Give the agent the whole brief verbatim and tell it to work in the current directory, which is a git worktree of the invoicely-agents repo ({WT}). The plugin is loaded from a separate copy, so files in this worktree can be written.

Evals run Claude and spend the Max limit: every `claude plugin eval` run, the agent's and yours, uses `--runs 1`, and a case that already passed is not run again unless its files changed. CI runs them once more on the PR.

When the agent is done:
1. Run: claude plugin validate .   and   node --test hooks/test/*.test.mjs
2. If both pass, stage everything (git add -A) and commit with a message whose first line starts with "{ISSUE}: " and that ends with exactly these two lines:
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DZpbhHzUVWiPy1aPcyVq5Y
3. git push -u origin {BRANCH}
4. gh pr create --base {BASE} --head {BRANCH} with a title that starts with "{ISSUE}: " and a body that is the agent's Bulgarian PR description, then a line "Linear: {ISSUE}", then a blank line and these two lines:
🤖 Generated with [Claude Code](https://claude.com/claude-code)
https://claude.ai/code/session_01DZpbhHzUVWiPy1aPcyVq5Y
Never merge and never push to main or to a feature/ branch: the runner merges when CI is green.

If the agent stops with a question instead of finishing, do not commit; end with the question and the agent's proposed answer.
End with: the PR URL (or the open question), the eval results per case, and the files changed.
