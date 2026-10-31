import { useId, useState } from "react";
import { useT } from "../i18n";

export type BotCatalogEntry = {
	id: string;
	name: string;
	description?: string;
	path?: string;
	status?: string;
	source?: string;
	warning?: "high_privilege" | "unsupported_platform";
};

export function LocalBotCatalogPicker({
	title,
	entries,
	selected,
	onChange,
	disabled,
	pending,
}: {
	title: string;
	entries: BotCatalogEntry[];
	selected: string[];
	onChange: (ids: string[]) => void;
	disabled: boolean;
	pending: boolean;
}) {
	const t = useT();
	const id = useId();
	const [query, setQuery] = useState("");
	const known = new Set(entries.map((entry) => entry.id));
	const unknown = selected.filter((value) => !known.has(value));
	const rows: BotCatalogEntry[] = [...entries, ...unknown.map((value) => ({ id: value, name: value }))];
	const search = query.trim().toLowerCase();
	const visible = rows.filter((entry) =>
		[entry.name, entry.id, entry.description, entry.path].some((value) => value?.toLowerCase().includes(search)),
	);
	const selectable = visible.filter((entry) => known.has(entry.id) && entry.status !== "disabled");
	return (
		<fieldset className="dc-bot-catalog" disabled={disabled}>
			<legend>
				{title}{" "}
				<span className="dc-bot-count">
					{selected.length} {t("localBotSelected")}
				</span>
			</legend>
			<div className="dc-bot-catalog-actions">
				<input
					type="search"
					aria-label={`${t("localBotSearch")} ${title}`}
					placeholder={t("localBotSearch")}
					value={query}
					onChange={(event) => setQuery(event.target.value)}
				/>
				<button
					type="button"
					className="dc-button"
					disabled={pending || !selectable.length}
					onClick={() => onChange([...new Set([...selected, ...selectable.map((entry) => entry.id)])])}
				>
					{search ? t("localBotSelectVisible") : t("localBotSelectAll")}
				</button>
				<button type="button" className="dc-button" disabled={!selected.length} onClick={() => onChange([])}>
					{t("localBotClear")}
				</button>
			</div>
			<div className="dc-bot-catalog-list">
				{visible.map((entry, index) => (
					<label
						className={`dc-bot-option${selected.includes(entry.id) ? " is-selected" : ""}`}
						key={entry.id}
						htmlFor={`${id}-${index}`}
					>
						<input
							id={`${id}-${index}`}
							type="checkbox"
							checked={selected.includes(entry.id)}
							disabled={entry.status === "disabled" && !selected.includes(entry.id)}
							onChange={(event) =>
								onChange(
									event.target.checked
										? [...new Set([...selected, entry.id])]
										: selected.filter((value) => value !== entry.id),
								)
							}
						/>
						<span>
							<strong>{entry.name}</strong>
							{entry.warning === "high_privilege" && <small>{t("localBotToolHighPrivilege")}</small>}
							{entry.warning === "unsupported_platform" && <small>{t("localBotToolUnsupportedPlatform")}</small>}
							{!known.has(entry.id) && <small>{pending ? t("localBotUnverified") : t("localBotUnavailable")}</small>}
							{entry.description && (
								<small className="dc-bot-option-description" title={entry.description}>
									{entry.description}
								</small>
							)}
							{entry.status === "not_loaded" && <small>{t("localBotMcpNotLoaded")}</small>}
							{entry.status === "disabled" && <small>{t("localBotMcpDisabled")}</small>}
							{entry.source && entry.source !== "builtin" && (
								<small className="dc-bot-option-source">{entry.source}</small>
							)}
							{entry.path && (
								<small className="dc-bot-option-path" title={entry.path}>
									{entry.path}
								</small>
							)}
						</span>
					</label>
				))}
				{!visible.length && <p>{pending ? t("localBotOptionsLoading") : t("localBotNoOptions")}</p>}
			</div>
		</fieldset>
	);
}
