export function ClaudeAccessOptions() {
  return <>
    <p className="small"><b>Wayfinder needs your own Anthropic API key.</b></p>
    <ul className="small claude-options">
      <li><b>An Anthropic API key</b> (pay per use, billed by Anthropic). Paste it below; it's stored on this machine only. You can also set <code>ANTHROPIC_API_KEY</code> before starting Wayfinder.</li>
    </ul>
    <p className="muted small">Prices: <a href="https://claude.com/pricing" target="_blank" rel="noreferrer">claude.com/pricing</a>.</p>
  </>;
}
