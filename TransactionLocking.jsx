import { useEffect, useMemo, useRef, useState } from "react";
import "./TransactionLocking.css";

const API_URL = (import.meta.env.VITE_API_URL || "http://localhost:8080").replace(/\/+$/, "");

const PERMISSION_FIELDS = [
  { key: "can_lock_invoice", shortLabel: "Invoice", label: "Invoice Lock" },
  { key: "can_lock_quotation", shortLabel: "Quotation", label: "Quotation Lock" },
  { key: "can_lock_official_receipt", shortLabel: "Receipt", label: "Official Receipt Lock" },
  { key: "can_lock_check_voucher", shortLabel: "Check Voucher", label: "Check Voucher Lock" },
  { key: "can_lock_journal_voucher", shortLabel: "Journal", label: "Journal Voucher Lock" },
  { key: "can_unlock_transactions", shortLabel: "Unlock", label: "Unlock Transactions" },
];

const LOCK_FIELDS = PERMISSION_FIELDS.filter(({ key }) => key !== "can_unlock_transactions");
const getToken = () => localStorage.getItem("token") || sessionStorage.getItem("token") || "";

function normalizePermission(user) {
  return PERMISSION_FIELDS.reduce(
    (result, { key }) => ({ ...result, [key]: Boolean(user[key]) }),
    user,
  );
}

function formatRole(role) {
  return String(role || "user")
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getInitials(user) {
  return String(user.full_name || user.username || "User")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 2v3M17 2v3M3.5 9h17M5.5 4h13a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />
    </svg>
  );
}

function formatDateDisplay(value) {
  if (!value) return "MM/DD/YYYY";
  const [year, month, day] = value.split("-");
  return `${month}/${day}/${year}`;
}

function toDateValue(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function parseDateValue(value) {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function PeriodDateField({ label, value, onOpen }) {
  return (
    <div className="locking-period-date">
      <input type="text" value={formatDateDisplay(value)} readOnly aria-label={label} onClick={onOpen} />
      <button type="button" onClick={onOpen} aria-label={`Open ${label} calendar`} title={label}>
        <CalendarIcon />
      </button>
    </div>
  );
}

function MonthCalendar({ month, range, onSelect }) {
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const firstWeekday = new Date(year, monthIndex, 1).getDay();
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const cells = Array.from({ length: 42 }, (_, index) => {
    const day = index - firstWeekday + 1;
    return day > 0 && day <= daysInMonth ? new Date(year, monthIndex, day) : null;
  });
  const today = toDateValue(new Date());

  return (
    <div className="range-month">
      <h3>{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h3>
      <div className="range-weekdays">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => <span key={day}>{day}</span>)}
      </div>
      <div className="range-days">
        {cells.map((date, index) => {
          if (!date) return <span className="range-day calendar-empty" key={`empty-${index}`} />;
          const value = toDateValue(date);
          const isStart = value === range.from;
          const isEnd = value === range.to;
          const inRange = range.from && range.to && value > range.from && value < range.to;
          const className = [
            "range-day",
            isStart ? "range-start" : "",
            isEnd ? "range-end" : "",
            inRange ? "in-range" : "",
            value === today ? "today" : "",
          ].filter(Boolean).join(" ");

          return (
            <button type="button" className={className} key={value} onClick={() => onSelect(value)}>
              {date.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function TransactionLocking() {
  const [tab, setTab] = useState("permissions");
  const [permissions, setPermissions] = useState([]);
  const [history, setHistory] = useState([]);
  const [periods, setPeriods] = useState([]);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [dateFilter, setDateFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [savingUserId, setSavingUserId] = useState(null);
  const [savingPeriodCode, setSavingPeriodCode] = useState(null);
  const [message, setMessage] = useState(null);
  const [rangeEditorCode, setRangeEditorCode] = useState(null);
  const [rangeDraft, setRangeDraft] = useState({ from: "", to: "" });
  const [calendarMonth, setCalendarMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const dateInputRef = useRef(null);
  const loadInFlightRef = useRef(false);
  const permissionInFlightRef = useRef(false);
  const periodInFlightRef = useRef(false);
  const hasLoadedRef = useRef(false);

  async function apiRequest(path, options = {}) {
    const response = await fetch(`${API_URL}/api/transaction-locking${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getToken()}`,
        ...options.headers,
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || "Unable to complete the request.");
    return data;
  }

  async function loadData() {
    if (loadInFlightRef.current) return;

    const isInitialLoad = !hasLoadedRef.current;
    loadInFlightRef.current = true;
    if (isInitialLoad) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }
    setMessage(null);
    try {
      const [permissionData, historyData, periodData] = await Promise.all([
        apiRequest("/permissions"),
        apiRequest("/history"),
        apiRequest("/periods"),
      ]);
      setPermissions(Array.isArray(permissionData) ? permissionData.map(normalizePermission) : []);
      setHistory(Array.isArray(historyData) ? historyData : []);
      setPeriods(Array.isArray(periodData) ? periodData : []);
      hasLoadedRef.current = true;
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      loadInFlightRef.current = false;
      if (isInitialLoad) {
        setLoading(false);
      } else {
        setRefreshing(false);
      }
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  const roles = useMemo(
    () => [...new Set(permissions.map((user) => user.role).filter(Boolean))],
    [permissions],
  );

  const filteredPermissions = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return permissions.filter((user) => {
      const matchesSearch =
        !keyword ||
        [user.username, user.full_name, user.role].some((value) =>
          String(value || "").toLowerCase().includes(keyword),
        );
      return matchesSearch && (roleFilter === "all" || user.role === roleFilter);
    });
  }, [permissions, roleFilter, search]);

  const filteredHistory = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return history.filter((entry) => {
      const matchesSearch =
        !keyword ||
        [entry.locked_by, entry.transaction_type, entry.transaction_number, entry.lock_reason].some(
        (value) => String(value || "").toLowerCase().includes(keyword),
        );

      if (!matchesSearch || !dateFilter) return matchesSearch;

      const entryDate = new Date(entry.locked_at);
      const localDate = Number.isNaN(entryDate.getTime())
        ? ""
        : [
            entryDate.getFullYear(),
            String(entryDate.getMonth() + 1).padStart(2, "0"),
            String(entryDate.getDate()).padStart(2, "0"),
          ].join("-");

      return localDate === dateFilter;
    });
  }, [dateFilter, history, search]);

  const filteredPeriods = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return periods;

    return periods.filter((period) =>
      [period.journal_code, period.title, period.book_code, period.book_title].some(
        (value) => String(value || "").toLowerCase().includes(keyword),
      ),
    );
  }, [periods, search]);

  const summary = useMemo(
    () => ({
      totalUsers: permissions.length,
      activeProfiles: permissions.filter((user) =>
        PERMISSION_FIELDS.some(({ key }) => user[key]),
      ).length,
      canUnlock: permissions.filter((user) => user.can_unlock_transactions).length,
      lockAccess: permissions.filter((user) => LOCK_FIELDS.some(({ key }) => user[key])).length,
    }),
    [permissions],
  );

  async function togglePermission(user, field) {
    if (permissionInFlightRef.current) return;

    permissionInFlightRef.current = true;
    const updatedUser = { ...user, [field]: !user[field] };
    setSavingUserId(user.id);
    setMessage(null);
    try {
      const result = await apiRequest(`/permissions/${user.id}`, {
        method: "PUT",
        body: JSON.stringify(
          Object.fromEntries(PERMISSION_FIELDS.map(({ key }) => [key, Boolean(updatedUser[key])])),
        ),
      });
      setPermissions((current) =>
        current.map((item) => (item.id === user.id ? updatedUser : item)),
      );
      setMessage({ type: "success", text: result.message });
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      permissionInFlightRef.current = false;
      setSavingUserId(null);
    }
  }

  function openRangeEditor(period) {
    const startingDate = parseDateValue(period.date_from) || new Date();
    setRangeEditorCode(period.journal_code);
    setRangeDraft({ from: period.date_from || "", to: period.date_to || "" });
    setCalendarMonth(new Date(startingDate.getFullYear(), startingDate.getMonth(), 1));
  }

  function selectRangeDate(value) {
    setRangeDraft((current) => {
      if (!current.from || current.to || value < current.from) {
        return { from: value, to: "" };
      }

      return { from: current.from, to: value };
    });
  }

  function moveCalendar(monthOffset) {
    setCalendarMonth((current) =>
      new Date(current.getFullYear(), current.getMonth() + monthOffset, 1),
    );
  }

  function applyRangeSelection() {
    if (!rangeEditorCode || !rangeDraft.from || !rangeDraft.to) return;

    setPeriods((current) =>
      current.map((period) =>
        period.journal_code === rangeEditorCode
          ? { ...period, date_from: rangeDraft.from, date_to: rangeDraft.to }
          : period,
      ),
    );
    setRangeEditorCode(null);
  }

  async function savePeriod(period) {
    if (periodInFlightRef.current) return;

    if (period.date_from && period.date_to && period.date_from > period.date_to) {
      setMessage({ type: "error", text: "Date From cannot be later than Date To." });
      return;
    }

    periodInFlightRef.current = true;
    setSavingPeriodCode(period.journal_code);
    setMessage(null);
    try {
      const result = await apiRequest(`/periods/${period.journal_code}`, {
        method: "PUT",
        body: JSON.stringify({
          date_from: period.date_from || null,
          date_to: period.date_to || null,
        }),
      });
      setMessage({ type: "success", text: result.message });
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      periodInFlightRef.current = false;
      setSavingPeriodCode(null);
    }
  }

  function switchTab(nextTab) {
    setTab(nextTab);
    setSearch("");
    setRoleFilter("all");
    setDateFilter("");
  }

  function openDatePicker() {
    const input = dateInputRef.current;
    if (!input) return;

    if (typeof input.showPicker === "function") {
      input.showPicker();
    } else {
      input.focus();
      input.click();
    }
  }

  return (
    <div className="transaction-locking-page">
      <header className="locking-page-header">
        <div>
          <span className="locking-eyebrow">System Administration</span>
          <h1>Transaction Locking</h1>
          <p>Control who can lock accounting records and review transaction lock activity.</p>
        </div>
        <button
          type="button"
          className="locking-refresh-primary"
          onClick={loadData}
          disabled={loading || refreshing}
          aria-busy={loading || refreshing}
        >
          {(loading || refreshing) && <span className="locking-refresh-spinner" aria-hidden="true" />}
          {loading ? "Loading data..." : refreshing ? "Refreshing..." : "Refresh Data"}
        </button>
      </header>

      {message && (
        <div className={`locking-message ${message.type}`}>
          <span>{message.type === "success" ? "OK" : "!"}</span>
          <p>{message.text}</p>
          <button type="button" onClick={() => setMessage(null)}>Close</button>
        </div>
      )}

      <section className="locking-summary" aria-label="Permission summary">
        {[
          ["Total Users", summary.totalUsers, "Available security profiles"],
          ["Active Profiles", summary.activeProfiles, "At least one permission enabled"],
          ["Can Unlock", summary.canUnlock, "Users with unlock authority"],
          ["Lock Access", summary.lockAccess, "Users who can lock records"],
        ].map(([label, value, detail]) => (
          <article className="locking-summary-card" key={label}>
            <span>{label}</span><strong>{value}</strong><small>{detail}</small>
          </article>
        ))}
      </section>

      <section
        className={`locking-panel${refreshing ? " is-refreshing" : ""}`}
        aria-busy={refreshing}
      >
        <div className="locking-tabs" role="tablist">
          <button type="button" className={tab === "permissions" ? "active" : ""} onClick={() => switchTab("permissions")}>
            Permissions <span>{permissions.length}</span>
          </button>
          <button type="button" className={tab === "periods" ? "active" : ""} onClick={() => switchTab("periods")}>
            Lock Dates <span>{periods.length}</span>
          </button>
          <button type="button" className={tab === "history" ? "active" : ""} onClick={() => switchTab("history")}>
            Lock History <span>{history.length}</span>
          </button>
        </div>

        <div className="locking-toolbar">
          <div className="locking-search">
            <span aria-hidden="true">Search</span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={
                tab === "permissions"
                  ? "Search user, name, or role..."
                  : tab === "periods"
                    ? "Search journal or book..."
                    : "Search user, transaction, or reason..."
              }
            />
          </div>
          {tab === "permissions" && (
            <select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)} aria-label="Filter by role">
              <option value="all">All roles</option>
              {roles.map((role) => <option key={role} value={role}>{formatRole(role)}</option>)}
            </select>
          )}
          {tab === "history" && (
            <label className="locking-date-filter">
              <span>Date</span>
              <div className="locking-date-input-wrap">
                <input
                  ref={dateInputRef}
                  type="date"
                  value={dateFilter}
                  onChange={(event) => setDateFilter(event.target.value)}
                  aria-label="Filter lock history by date"
                />
                <button
                  type="button"
                  className="locking-calendar-button"
                  onClick={openDatePicker}
                  aria-label="Open calendar"
                  title="Choose a date"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M7 2v3M17 2v3M3.5 9h17M5.5 4h13a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />
                  </svg>
                </button>
              </div>
            </label>
          )}
          <span className="locking-result-count">
            {tab === "permissions"
              ? `${filteredPermissions.length} users`
              : tab === "periods"
                ? `${filteredPeriods.length} journals`
                : `${filteredHistory.length} events`}
          </span>
        </div>

        {tab === "permissions" ? (
          <div className="locking-table-wrapper">
            <table className="locking-table permission-table">
              <thead><tr><th>User</th><th>Role</th>{PERMISSION_FIELDS.map((field) => <th key={field.key} title={field.label}>{field.shortLabel}</th>)}</tr></thead>
              <tbody>
                {loading || filteredPermissions.length === 0 ? (
                  <tr><td colSpan={PERMISSION_FIELDS.length + 2} className="locking-empty">{loading ? "Loading permission profiles..." : "No users match the current filters."}</td></tr>
                ) : filteredPermissions.map((user) => (
                  <tr key={user.id}>
                    <td><div className="locking-user-cell"><span className="locking-avatar">{getInitials(user)}</span><div><strong>{user.full_name || user.username}</strong><small>@{user.username}</small></div></div></td>
                    <td><span className={`locking-role role-${user.role}`}>{formatRole(user.role)}</span></td>
                    {PERMISSION_FIELDS.map((field) => (
                      <td key={field.key} className="permission-cell">
                        <label className="permission-switch" title={field.label}>
                          <input type="checkbox" checked={Boolean(user[field.key])} onChange={() => togglePermission(user, field.key)} disabled={savingUserId !== null} />
                          <span /><em>{user[field.key] ? "On" : "Off"}</em>
                        </label>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : tab === "periods" ? (
          <div className="locking-table-wrapper">
            <table className="locking-table lock-period-table">
              <thead>
                <tr>
                  <th>Journal Code</th>
                  <th>Title</th>
                  <th>Book Code</th>
                  <th>Book Title</th>
                  <th>Date From</th>
                  <th>Date To</th>
                  <th className="period-action-heading">Action</th>
                </tr>
              </thead>
              <tbody>
                {loading || filteredPeriods.length === 0 ? (
                  <tr>
                    <td colSpan="7" className="locking-empty">
                      {loading ? "Loading lock date periods..." : "No journals match the current search."}
                    </td>
                  </tr>
                ) : filteredPeriods.map((period) => (
                  <tr key={period.journal_code}>
                    <td><span className="journal-code-badge">{period.journal_code}</span></td>
                    <td><strong>{period.title}</strong></td>
                    <td>{period.book_code}</td>
                    <td>{period.book_title}</td>
                    <td>
                      <PeriodDateField
                        label={`${period.journal_code} Date From`}
                        value={period.date_from}
                        onOpen={() => openRangeEditor(period)}
                      />
                    </td>
                    <td>
                      <PeriodDateField
                        label={`${period.journal_code} Date To`}
                        value={period.date_to}
                        onOpen={() => openRangeEditor(period)}
                      />
                    </td>
                    <td className="period-action-cell">
                      <button
                        type="button"
                        className="save-period-button"
                        onClick={() => savePeriod(period)}
                        disabled={savingPeriodCode !== null}
                      >
                        {savingPeriodCode === period.journal_code ? "Saving..." : "Save"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="locking-table-wrapper">
            <table className="locking-table history-table">
              <thead><tr><th>Date and Time</th><th>User</th><th>Transaction</th><th>Action</th><th>Reason</th></tr></thead>
              <tbody>
                {loading || filteredHistory.length === 0 ? (
                  <tr><td colSpan="5" className="locking-empty">{loading ? "Loading lock history..." : "No lock history has been recorded yet."}</td></tr>
                ) : filteredHistory.map((entry) => (
                  <tr key={entry.id}>
                    <td className="locking-date">{entry.locked_at ? new Date(entry.locked_at).toLocaleString() : "Unknown"}</td>
                    <td>{entry.locked_by || "System"}</td>
                    <td><strong>{entry.transaction_type}</strong><small className="transaction-number">{entry.transaction_number}</small></td>
                    <td><span className={`locking-action ${entry.is_locked ? "locked" : "unlocked"}`}>{entry.is_locked ? "Locked" : "Unlocked"}</span></td>
                    <td className="locking-reason">{entry.lock_reason || "No reason provided"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {rangeEditorCode && (
        <div
          className="range-calendar-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setRangeEditorCode(null);
          }}
        >
          <div className="range-calendar-dialog" role="dialog" aria-modal="true" aria-label="Select lock date range">
            <div className="range-calendar-header">
              <div>
                <span>Lock period</span>
                <h2>{rangeEditorCode} Date Range</h2>
              </div>
              <button type="button" className="range-close" onClick={() => setRangeEditorCode(null)}>
                Close
              </button>
            </div>

            <div className="range-selection-bar">
              <button type="button" className="range-reset" onClick={() => setRangeDraft({ from: "", to: "" })}>
                Reset
              </button>
              <div className={`range-value ${rangeDraft.from ? "selected" : ""}`}>
                <CalendarIcon />
                <span><small>Date From</small>{formatDateDisplay(rangeDraft.from)}</span>
              </div>
              <span className="range-arrow">to</span>
              <div className={`range-value ${rangeDraft.to ? "selected" : ""}`}>
                <CalendarIcon />
                <span><small>Date To</small>{formatDateDisplay(rangeDraft.to)}</span>
              </div>
            </div>

            <div className="range-calendar-content">
              <button type="button" className="month-navigation previous" onClick={() => moveCalendar(-1)} aria-label="Previous month">
                ‹
              </button>
              <MonthCalendar month={calendarMonth} range={rangeDraft} onSelect={selectRangeDate} />
              <MonthCalendar
                month={new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1)}
                range={rangeDraft}
                onSelect={selectRangeDate}
              />
              <button type="button" className="month-navigation next" onClick={() => moveCalendar(1)} aria-label="Next month">
                ›
              </button>
            </div>

            <div className="range-calendar-footer">
              <p>
                {!rangeDraft.from
                  ? "Choose the first day of the lock period."
                  : !rangeDraft.to
                    ? "Now choose the last day of the lock period."
                    : `${formatDateDisplay(rangeDraft.from)} to ${formatDateDisplay(rangeDraft.to)}`}
              </p>
              <div>
                <button type="button" className="range-cancel" onClick={() => setRangeEditorCode(null)}>Cancel</button>
                <button type="button" className="range-done" onClick={applyRangeSelection} disabled={!rangeDraft.from || !rangeDraft.to}>Done</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
