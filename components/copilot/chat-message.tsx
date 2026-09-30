"use client";


/**
 * Thread chrome: user on the right, copilot on the left.
 *
 * Not sample data: every line comes from a stored turn or the live `/api/copilot` reply.
 */


/**
 * Where an assistant turn's TEXT starts: the 18px mark plus the 10px gap beside it. Lines that
 * belong to the reply but sit outside it (the "Checked in" clock, the progress line) use this
 * so they line up under the words, not under the logo.
 */
export const ASSISTANT_TEXT_INDENT = "pl-7";
export function UserBubble({ children }: { children: React.ReactNode }) {
  return (
    // The shell pins the latest of these to the top of the view on send (copilot-shell.tsx).
    <div data-cp-user-bubble="" style={{ display: "flex", justifyContent: "flex-end" }}>
      <p
        style={{
          maxWidth: "82%",
          margin: 0,
          background: "var(--g50)",
          border: "1px solid var(--g100)",
          borderRadius: 14,
          padding: "9px 14px",
          fontSize: 14,
          lineHeight: "21px",
          color: "var(--g800)",
          textWrap: "pretty",
        }}
      >
        {children}
      </p>
    </div>
  );
}

export function AssistantMessage({
  children,
  note,
  tone = "default",
}: {
  children: React.ReactNode;
  note?: string | null;
  tone?: "default" | "error";
}) {
  return (
    <div>
      {typeof children === "string" ? (
        <AssistantBody text={children} color={tone === "error" ? "var(--z-danger, #c23d3d)" : null} />
      ) : (
        <p
          style={{
            margin: 0,
            fontSize: 16,
            lineHeight: "26px",
            color: tone === "error" ? "var(--z-danger, #c23d3d)" : "var(--g800)",
            textWrap: "pretty",
            whiteSpace: "pre-wrap",
          }}
        >
          {children}
        </p>
      )}
      {note ? (
        <div
          style={{
            display: "flex",
            gap: 10,
            borderTop: "1px solid var(--g100)",
            paddingTop: 10,
            marginTop: 10,
            fontSize: 12,
            lineHeight: "18px",
            color: "var(--g500)",
            textWrap: "pretty",
          }}
        >
          <span style={{ color: "var(--g300)", flex: "none" }}>Note</span>
          <span>{note}</span>
        </div>
      ) : null}
    </div>
  );
}

/** Prose only — the headline paragraph, without the figures `answerToText` appended. */
export function chatProseFromStored(text: string): string {
  const first = chatBlocksFromStored(text).find((b) => b.kind === "p");
  return first && first.kind === "p" ? first.text : "";
}

/**
 * An assistant turn, back in the shape it was written in.
 *
 * WHY A PARSER AND NOT A NEW RESPONSE FIELD
 *
 * The read path builds a `StructuredAnswer` — headline, facts, sections, tables — and
 * flattens it with `answerToText` (answer-schema.ts) to get the `message` that every
 * surface stores. This renderer threw away everything after the headline, so a read that
 * had already fetched the numbers printed only the sentence: "3 supplied, ~$100,239.97
 * total" with the three pools it had just read deleted one layer above the screen.
 *
 * `answerToText` and this function are a serialiser/parser pair over one format, so every
 * answer shape that exists — and every one added later — renders without anything here
 * naming a tool, a template or an asset. It also repairs turns already in storage, which
 * a new response field could not.
 *
 * The format, exactly as `answerToText` writes it:
 *   prose          any other line
 *   fact           "• label: value"
 *   section fact   label, a run of spaces, value
 *   table row      cells joined by " | "
 */
export type ChatBlock =
  | { kind: "p"; text: string }
  | { kind: "facts"; rows: Array<{ label: string; value: string }> }
  | { kind: "table"; rows: string[][] };

export function chatBlocksFromStored(text: string): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  let prose: string[] = [];
  let facts: Array<{ label: string; value: string }> = [];
  let table: string[][] = [];

  const flushProse = () => {
    const joined = prose.join("\n").trim();
    if (joined) blocks.push({ kind: "p", text: joined });
    prose = [];
  };
  const flushFacts = () => {
    if (facts.length) blocks.push({ kind: "facts", rows: facts });
    facts = [];
  };
  const flushTable = () => {
    if (table.length) blocks.push({ kind: "table", rows: table });
    table = [];
  };
  const flushAll = () => {
    flushProse();
    flushFacts();
    flushTable();
  };

  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    if (!line) {
      flushAll();
      continue;
    }
    const bullet = /^•\s*([^:]+):\s*(.+)$/.exec(line);
    if (bullet) {
      flushProse();
      flushTable();
      facts.push({ label: bullet[1]!.trim(), value: bullet[2]!.trim() });
      continue;
    }
    if (line.includes(" | ")) {
      flushProse();
      flushFacts();
      table.push(line.split(" | ").map((c) => c.trim()));
      continue;
    }
    // A section's compact strip: label and value separated by the run of spaces
    // `answerToText` puts between them, with no second run inside the value.
    const strip = /^•?\s*(\S.*?)\s{2,}(\S.*)$/.exec(line);
    if (strip && !/\s{2,}/.test(strip[2]!)) {
      flushProse();
      flushTable();
      facts.push({ label: strip[1]!.trim(), value: strip[2]!.trim() });
      continue;
    }
    flushFacts();
    flushTable();
    prose.push(line.replace(/^•\s*/, ""));
  }
  flushAll();
  return blocks;
}

function FactRows({ rows }: { rows: Array<{ label: string; value: string }> }) {
  return (
    <div className="mt-2.5 grid grid-cols-1 gap-x-8 sm:grid-cols-2">
      {rows.map((r, i) => (
        <div
          key={i}
          className="flex items-baseline justify-between gap-4 border-b border-vgray-100 py-1.5"
        >
          <span className="min-w-0 truncate text-[11px] uppercase tracking-[0.08em] text-vgray-500">
            {r.label}
          </span>
          <span className="shrink-0 font-mono text-[13px] text-vgray-900">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

function FactTable({ rows }: { rows: string[][] }) {
  const [head, ...body] = rows;
  return (
    <div className="mt-2.5 overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        {head ? (
          <thead>
            <tr>
              {head.map((c, i) => (
                <th
                  key={i}
                  className="border-b border-vgray-100 py-1.5 pr-4 text-left text-[11px] font-medium uppercase tracking-[0.08em] text-vgray-500"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
        ) : null}
        <tbody>
          {body.map((row, i) => (
            <tr key={i}>
              {row.map((c, j) => (
                <td
                  key={j}
                  className={`border-b border-vgray-100 py-1.5 pr-4 ${
                    j === 0 ? "text-vgray-700" : "font-mono text-vgray-900"
                  }`}
                >
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Every block the turn actually carries — prose, figures, tables. */
export function AssistantBody({ text, color = null }: { text: string; color?: string | null }) {
  const blocks = chatBlocksFromStored(text);
  if (!blocks.length) return null;
  return (
    <>
      {blocks.map((b, i) =>
        b.kind === "p" ? (
          <p
            key={i}
            style={{
              margin: i === 0 ? 0 : "10px 0 0",
              fontSize: i === 0 ? 16 : 14,
              lineHeight: i === 0 ? "26px" : "22px",
              color: color ?? (i === 0 ? "var(--g800)" : "var(--g700)"),
              textWrap: "pretty",
              whiteSpace: "pre-wrap",
            }}
          >
            {b.text}
          </p>
        ) : b.kind === "facts" ? (
          <FactRows key={i} rows={b.rows} />
        ) : (
          <FactTable key={i} rows={b.rows} />
        ),
      )}
    </>
  );
}


/** One assistant reply: the Vanna mark, then whatever the turn carries, aligned to the words. */
export function AssistantRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 max-w-[85%]">
      <img
        src="/logos/vanna-icon.png"
        alt="Vanna"
        width={18}
        height={18}
        className="h-[18px] w-[18px] shrink-0 mt-1 rounded-full"
      />
      <div className="flex flex-col gap-2 min-w-0 w-full">{children}</div>
    </div>
  );
}

/** The in-flight reply: shown from send until the server answers. */
export function WorkingRow({ label = "Working…" }: { label?: string }) {
  return (
    <div className="flex items-start gap-2.5 max-w-[85%]">
      <img
        src="/logos/vanna-icon.png"
        alt="Vanna"
        width={18}
        height={18}
        className="h-[18px] w-[18px] shrink-0 mt-0.5 rounded-full"
      />
      <p role="status" aria-live="polite" className="text-[13px] leading-[20px] text-violet-500">{label}</p>
    </div>
  );
}
