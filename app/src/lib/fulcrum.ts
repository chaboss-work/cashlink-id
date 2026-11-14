// Minimal Electrum Cash protocol client (Fulcrum) over WebSocket, with server failover.
// Works in browsers and in Node >= 22 (global WebSocket).

export const DEFAULT_SERVERS = ["wss://bch.imaginary.cash:50004", "wss://bch.loping.net:50004", "wss://electroncash.de:60002"];

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class Fulcrum {
  private ws: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private txCache = new Map<string, string>();
  server = "";

  constructor(
    private servers: string[] = DEFAULT_SERVERS,
    private timeoutMs = 12000,
  ) {}

  private open(url: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const t = setTimeout(() => {
        ws.close();
        reject(new Error(`timeout connecting to ${url}`));
      }, 6000);
      ws.onopen = () => {
        clearTimeout(t);
        resolve(ws);
      };
      ws.onerror = () => {
        clearTimeout(t);
        reject(new Error(`cannot connect to ${url}`));
      };
    });
  }

  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const errors: string[] = [];
      for (const url of this.servers) {
        try {
          const ws = await this.open(url);
          ws.onmessage = (ev) => this.onMessage(String(ev.data));
          ws.onclose = () => {
            if (this.ws === ws) this.ws = null;
            for (const [id, p] of this.pending) {
              clearTimeout(p.timer);
              p.reject(new Error("connection closed"));
              this.pending.delete(id);
            }
          };
          this.ws = ws;
          this.server = url;
          await this.send("server.version", ["CashLink ID", ["1.4", "1.6"]]).catch(() => this.send("server.version", ["CashLink ID", "1.4"]));
          return;
        } catch (e) {
          errors.push(String((e as Error).message ?? e));
          this.ws = null;
        }
      }
      throw new Error(`No Fulcrum server reachable (${errors.join("; ")})`);
    })().finally(() => (this.connecting = null));
    return this.connecting;
  }

  private onMessage(text: string) {
    let msgs: any;
    try {
      msgs = JSON.parse(text);
    } catch {
      return;
    }
    for (const m of Array.isArray(msgs) ? msgs : [msgs]) {
      if (typeof m?.id !== "number") continue; // subscription notifications are not used
      const p = this.pending.get(m.id);
      if (!p) continue;
      clearTimeout(p.timer);
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(typeof m.error === "string" ? m.error : m.error.message ?? JSON.stringify(m.error)));
      else p.resolve(m.result);
    }
  }

  private send(method: string, params: unknown[]): Promise<any> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("not connected"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: timeout`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  async request(method: string, ...params: unknown[]): Promise<any> {
    await this.connect();
    try {
      return await this.send(method, params);
    } catch (e) {
      // one retry on a fresh connection (servers drop idle sockets)
      if (String(e).includes("not connected") || String(e).includes("connection closed")) {
        await this.connect();
        return this.send(method, params);
      }
      throw e;
    }
  }

  async getTransaction(txid: string): Promise<string> {
    const hit = this.txCache.get(txid);
    if (hit) return hit;
    const hex: string = await this.request("blockchain.transaction.get", txid);
    this.txCache.set(txid, hex);
    return hex;
  }

  async tipHeight(): Promise<number> {
    const h = await this.request("blockchain.headers.get_tip");
    return h.height;
  }

  async history(scripthash: string): Promise<{ tx_hash: string; height: number }[]> {
    return this.request("blockchain.scripthash.get_history", scripthash);
  }

  async listUnspent(scripthash: string): Promise<{ tx_hash: string; tx_pos: number; value: number; height: number; token_data?: unknown }[]> {
    return this.request("blockchain.scripthash.listunspent", scripthash);
  }

  async broadcast(hex: string): Promise<string> {
    return this.request("blockchain.transaction.broadcast", hex);
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }
}

let shared: Fulcrum | null = null;
export function fulcrum(): Fulcrum {
  return (shared ??= new Fulcrum());
}
