export class BdCliAdapter {
  constructor({ run }) { if (typeof run !== "function") throw new TypeError("run is required"); this.run = run; }
  async show(issueId) { return this.json(["show", issueId, "--json"]); }
  async claim(issueId) { return this.json(["update", issueId, "--claim", "--json"]); }
  async checkpoint(issueId, note) { return this.json(["update", issueId, "--append-notes", String(note).slice(0, 1000), "--json"]); }
  async close(issueId, note) { return this.json(["close", issueId, "--reason", String(note).slice(0, 1000), "--json"]); }
  async json(args) { const result = await this.run(args); if (result.code !== 0) throw new Error(`bd ${args[0]} failed: ${String(result.stderr ?? "").slice(0, 240)}`); try { return JSON.parse(result.stdout); } catch { throw new Error(`bd ${args[0]} returned invalid JSON`); } }
}
