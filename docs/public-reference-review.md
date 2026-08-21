# Public repository review

The repository structure was informed by several public n8n examples reviewed
in August 2026:

- [n8n workflow-template documentation](https://docs.n8n.io/workflows/templates/)
  confirms the import-and-configure model for reusable workflow JSON.
- [DavaXCode/n8n-workflows](https://github.com/DavaXCode/n8n-workflows) makes
  setup, credential placeholders, architecture choices, and limitations visible
  beside each importable workflow.
- [Samsing1989/n8n-automation-hub](https://github.com/Samsing1989/n8n-automation-hub)
  uses a clear catalog, sanitized IDs, per-workflow setup instructions, and an
  explicit technology summary.
- [scavio-ai/cookbooks](https://github.com/scavio-ai/cookbooks) includes a small
  scheduled Reddit-to-Slack n8n recipe and demonstrates keeping examples easy to
  locate and import.

## Practices adopted here

- A directly importable workflow at a predictable path.
- A short setup path with every credential boundary named.
- Sanitized placeholders that fail safely until configured.
- Architecture and security documentation beside the automation.
- Tests that verify the code and the workflow graph itself.
- Clear claims about what is production-derived and what remains an operator
  responsibility.

## Deliberate improvements

This project adds a threat model for untrusted social content, capability-level
prompt-injection controls, exact-thread comment correlation, deterministic
definition of “top,” independent-lane testing guidance, and automated checks
that reject a credential-bound export.
