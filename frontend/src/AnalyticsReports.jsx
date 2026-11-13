import { useEffect, useState } from "react";
import axios from "axios";
import { api } from "./api.js";
import { workspaceFailureMessage } from "./workspace.js";
import { validateAnalysis, validatePreview } from "./api-contracts.js";
import { Activity, BarChart3, CalendarDays, ChevronLeft, ChevronRight, Download, FileSpreadsheet, Filter, LoaderCircle, Search, Sparkles, Table2 } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const colors = ["#8052d6", "#4385f5", "#19b8a6", "#ff9a55", "#ed6aaf", "#6d6ae8", "#4bb9da"];
const number = value => value == null ? "?" : new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(value);
const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; } };
const save = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Keep working without browser storage. */ } };

export default function AnalyticsReports({ page, files, selectedId, onSelect }) {
  const workbooks = files.filter(f => f.kind === "spreadsheet");
  const workbook = workbooks.find(f => f.fileId === selectedId) || workbooks[0];
  useEffect(() => { if (workbook && workbook.fileId !== selectedId) onSelect(workbook.fileId); }, [workbook?.fileId, selectedId]);
  if (!workbook) return <div className="insights-page"><div className="insights-heading"><h1>{page}</h1></div><div className="insight-empty"><div><FileSpreadsheet size={32}/></div><h2>Your data, brought to life</h2><p>Upload an XLSX workbook or CSV file from Excel Files to explore real metrics, interactive charts, and downloadable reports.</p></div></div>;
  return <WorkbookView key={workbook.fileId} {...{ page, workbook, workbooks, onSelect }}/>;
}

function WorkbookView({ page, workbook, workbooks, onSelect }) {
  const storageKey = `technovalens.analysis.${workbook.fileId}`;
  const [controls, setControls] = useState(() => {
    const stored = read(storageKey, {});
    return { sheet: workbook.sheetNames?.includes(stored.sheet) ? stored.sheet : workbook.sheetNames?.[0] || "", search: stored.search || "", categoryColumn: stored.categoryColumn || "", categoryValue: stored.categoryValue || "" };
  });
  const [summary, setSummary] = useState(null), [table, setTable] = useState(null);
  const [schema, setSchema] = useState(null);
  const [sort, setSort] = useState(""), [direction, setDirection] = useState("asc"), [pageNo, setPageNo] = useState(1);
  const [loading, setLoading] = useState(true), [tableLoading, setTableLoading] = useState(true), [error, setError] = useState("");
  const [exporting, setExporting] = useState(""), [retry, setRetry] = useState(0);
  const [query, setQuery] = useState(controls);
  const isReport = page === "Reports";
  const update = patch => { setControls(previous => ({ ...previous, ...patch })); setPageNo(1); };
  useEffect(() => { save(storageKey, controls); const timer = setTimeout(() => setQuery(controls), 250); return () => clearTimeout(timer); }, [controls, storageKey]);
  const queryKey = JSON.stringify(query);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setSummary(null); setError("");
    api.get(`/analytics/${workbook.fileId}`, { params: query, signal: controller.signal })
      .then(({ data }) => { validateAnalysis(data); setSummary(data); setSchema(data); })
      .catch(err => { if (!axios.isCancel(err)) setError(workspaceFailureMessage(err) || err.response?.data?.error || err.message || "Could not analyze this workbook. Try again."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [workbook.fileId, queryKey, retry]);
  useEffect(() => {
    if (isReport) return;
    const controller = new AbortController(); setTableLoading(true); setTable(null);
    api.get(`/analytics/${workbook.fileId}/preview`, { params: { ...query, page: pageNo, pageSize: 12, sort, direction }, signal: controller.signal })
      .then(({ data }) => { validatePreview(data); setTable(data); if (data.page !== pageNo) setPageNo(data.page); })
      .catch(err => { if (!axios.isCancel(err)) setError(workspaceFailureMessage(err) || err.response?.data?.error || err.message || "Could not load the data preview."); })
      .finally(() => { if (!controller.signal.aborted) setTableLoading(false); });
    return () => controller.abort();
  }, [workbook.fileId, queryKey, pageNo, sort, direction, isReport, retry]);
  const pending = loading || JSON.stringify(controls) !== queryKey;
  async function download(format) {
    setExporting(format); setError("");
    try {
      const response = await api.get(`/reports/${workbook.fileId}.${format}`, { params: query, responseType: "blob" });
      const url = URL.createObjectURL(response.data), link = document.createElement("a");
      link.href = url; link.download = `${workbook.fileName.replace(/\.[^.]+$/, "")}-report.${format}`;
      document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      let message = "Could not export this report. Please try again.";
      if (err.response?.data instanceof Blob) { try { message = JSON.parse(await err.response.data.text()).error || message; } catch { /* Use fallback. */ } }
      setError(workspaceFailureMessage(err) || message);
    } finally { setExporting(""); }
  }
  return <div className="insights-page" aria-busy={pending}>
    <div className="insights-heading"><div><span className="eyebrow"><Sparkles size={14}/> WORKBOOK INTELLIGENCE</span><h1>{page}</h1><p>{isReport ? "A professional report, grounded in your data." : "Discover patterns. Measure quality. Explore every row."}</p></div>
      <div className="insights-actions"><label className="workbook-picker"><FileSpreadsheet size={17}/><select aria-label="Workbook" value={workbook.fileId} onChange={e => onSelect(e.target.value)}>{workbooks.map(f => <option key={f.fileId} value={f.fileId}>{f.fileName}</option>)}</select></label>
        <label className="workbook-picker"><Table2 size={16}/><select aria-label="Worksheet" value={controls.sheet} onChange={e => { update({ sheet: e.target.value, search: "", categoryColumn: "", categoryValue: "" }); setSort(""); }}>{workbook.sheetNames.map(name => <option key={name}>{name}</option>)}</select></label>
        {isReport && <><button disabled={pending || !summary || !!exporting} className="insight-button" onClick={() => download("xlsx")}><Download size={16}/>{exporting === "xlsx" ? "Exporting?" : "Excel"}</button><button disabled={pending || !summary || !!exporting} className="insight-button primary" onClick={() => download("pdf")}><Download size={16}/>{exporting === "pdf" ? "Exporting?" : "Download PDF"}</button></>}
      </div>
    </div>
    <div className="insight-fileline"><FileSpreadsheet size={16}/><b>{workbook.fileName}</b><span>?</span><CalendarDays size={15}/><span>{isReport && summary ? `Generated ${new Date(summary.generatedAt).toLocaleString()}` : `Uploaded ${new Date(workbook.uploadedAt).toLocaleDateString()}`}</span><span className="analysis-status" role="status">{pending ? <><LoaderCircle size={14} className="insight-spinner"/> Analyzing data?</> : error ? "Needs attention" : "Analysis complete"}</span></div>
    <section className="insight-card dataset-controls"><div className="table-controls"><label className="search-box"><Search size={16}/><input aria-label="Search dataset" value={controls.search} onChange={e => update({ search: e.target.value })} placeholder="Search all columns"/></label><label className="filter-box"><Filter size={15}/><select aria-label="Filter column" value={controls.categoryColumn} onChange={e => update({ categoryColumn: e.target.value, categoryValue: "" })}><option value="">All categories</option>{[...(schema?.types.category || []), ...(schema?.types.text || [])].map(c => <option key={c}>{c}</option>)}</select></label>{controls.categoryColumn && <input className="filter-box" aria-label="Exact category value" list="category-values" value={controls.categoryValue} onChange={e => update({ categoryValue: e.target.value })} placeholder="Exact value (blank = all)"/>}<datalist id="category-values">{(schema?.categories[controls.categoryColumn] || []).map(v => <option key={v} value={v}/>)}</datalist><button className="insight-button" onClick={() => update({ search: "", categoryColumn: "", categoryValue: "" })}>Reset filters</button></div><p>Charts, metrics, previews, and exports use the same filters. Workbook and worksheet choices are shared with {isReport ? "Analytics" : "Reports"}.</p></section>
    {error && <div role="alert" className="insight-error">{error} <button className="insight-button" onClick={() => setRetry(r => r+1)}>Retry</button></div>}
    {pending && <div className="insight-loading" role="status"><LoaderCircle className="insight-spinner" size={24}/><span>Calculating worksheet metrics and charts?</span></div>}
    {summary && !pending && <>
      <section className="insight-kpis">
        <Kpi icon={<Table2/>} label="Records" value={number(summary.rowCount)} tint="violet" hint={`${number(summary.totalRowCount)} in worksheet`}/>
        <Kpi icon={<BarChart3/>} label="Columns" value={number(summary.columnCount)} tint="blue" hint={`${summary.types.numeric.length} numeric ? ${summary.types.date.length} date`}/>
        <Kpi icon={<FileSpreadsheet/>} label="Worksheets" value={number(summary.sheetCount)} tint="teal" hint={summary.sheetName}/>
        <Kpi icon={<Filter/>} label="Missing values" value={number(summary.missingValues)} tint="orange" hint={summary.completeness == null ? "No cells to measure" : `${number(100-summary.completeness)}% of cells`}/>
        <Kpi icon={<Activity/>} label="Duplicate rows" value={number(summary.duplicateRows)} tint="pink" hint="beyond first occurrence"/>
        {summary.kpis.map((metric,i) => <Kpi key={metric.column} icon={<Sparkles/>} label={metric.label} value={number(metric.value)} tint={i % 2 ? "teal" : "blue"} hint={metric.hint}/>)}
      </section>
      {!summary.rowCount && <div className="insight-empty compact-empty"><h2>{summary.totalRowCount ? "No matching records" : "This worksheet has no data rows"}</h2><p>{summary.totalRowCount ? "Reset the filters or try another search." : "Choose another worksheet or upload a workbook with a header row and data."}</p></div>}
      <section className="insight-charts">
        <ChartCard title={summary.charts.trend.title} subtitle="Monthly sums ? latest 24 populated months" mark="trend" icon={<Activity size={17}/>}>
          {summary.charts.trend.data.length ? <ResponsiveContainer width="100%" height={245}><LineChart accessibilityLayer data={summary.charts.trend.data} margin={{top:10,right:18,left:4,bottom:0}}><CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eeeaf5"/><XAxis dataKey="period" tick={{fontSize:11,fill:"#837d92"}}/><YAxis width={66} tickFormatter={v => Intl.NumberFormat("en",{notation:"compact"}).format(v)} tick={{fontSize:11,fill:"#837d92"}}/><Tooltip formatter={number}/><Line isAnimationActive={false} type="linear" dataKey="value" name={summary.charts.trend.valueColumn} stroke="#8052d6" strokeWidth={3} dot={{r:3}}/></LineChart></ResponsiveContainer> : <ChartEmpty text="A trend needs an ISO date column and a numeric column. No values are estimated."/>}
        </ChartCard>
        <ChartCard title={summary.charts.bar.title} subtitle={`Top groups by record count${summary.charts.bar.omittedGroups ? ` ? ${summary.charts.bar.omittedGroups} more groups omitted` : ""}`} mark="bars" icon={<BarChart3 size={17}/>}>
          {summary.charts.bar.data.length ? <ResponsiveContainer width="100%" height={245}><BarChart accessibilityLayer data={summary.charts.bar.data} margin={{top:8,right:8,left:-15,bottom:0}}><CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eeeaf5"/><XAxis dataKey="name" tick={{fontSize:10,fill:"#837d92"}} tickFormatter={v => v.length > 15 ? `${v.slice(0,14)}?` : v}/><YAxis allowDecimals={false} tick={{fontSize:11,fill:"#837d92"}}/><Tooltip/><Bar isAnimationActive={false} dataKey="count" name="Records" radius={[7,7,0,0]}>{summary.charts.bar.data.map((r,i) => <Cell key={r.name} fill={colors[i%colors.length]}/>)}</Bar></BarChart></ResponsiveContainer> : <ChartEmpty text="No suitable category column is available. Unique identifiers and free text are not grouped into misleading charts."/>}
        </ChartCard>
        <ChartCard title="Category mix" subtitle="Share of all matching records ? smaller groups combined" mark="mix" icon={<Activity size={17}/>} className="pie-card">
          {summary.charts.pie.length ? <div className="pie-layout"><ResponsiveContainer width="54%" height={220}><PieChart><Pie isAnimationActive={false} data={summary.charts.pie} dataKey="count" nameKey="name" innerRadius={54} outerRadius={82} paddingAngle={2}>{summary.charts.pie.map((r,i) => <Cell key={r.name} fill={colors[i%colors.length]}/>)}</Pie><Tooltip formatter={(v) => `${number(v)} records (${number(v / summary.rowCount * 100)}%)`}/></PieChart></ResponsiveContainer><div className="pie-legend">{summary.charts.pie.map((item,i) => <div key={item.name}><i style={{background:colors[i%colors.length]}}/><span title={item.name}>{item.name}</span><b>{number(item.count)} ? {number(item.count/summary.rowCount*100)}%</b></div>)}</div></div> : <ChartEmpty text="A category column is needed for a mix chart."/>}
        </ChartCard>
      </section>
      {isReport && <section className="insight-card report-findings"><span className="eyebrow">CALCULATED OBSERVATIONS</span><h2>Notable findings</h2><ul>{summary.findings.map(f => <li key={f}>{f}</li>)}</ul></section>}
      <section className="insight-card quality-card"><div className="insight-card-title"><div><h2>Data quality & column profile</h2><p>Statistics for {number(summary.rowCount)} matching records ? only valid numeric values contribute to summaries</p></div><span className="chart-mark quality"><Filter size={17}/></span></div><div className="quality-table-wrap"><table className="quality-table"><thead><tr>{["Column","Type","Present","Missing","Invalid","Distinct","Sum","Average","Minimum","Maximum"].map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{Object.entries(summary.columnStats).map(([name,s]) => <tr key={name}><td><b>{name}</b></td><td><span className={`type-pill ${s.type}`}>{s.type}</span></td><td>{number(s.count-s.missing)}</td><td>{number(s.missing)}</td><td>{number(s.invalid)}</td><td>{number(s.unique)}</td><td>{number(s.sum)}</td><td>{number(s.average)}</td><td>{number(s.min)}</td><td>{number(s.max)}</td></tr>)}</tbody></table></div></section>
      {!isReport && <section className="insight-card preview-card"><div className="insight-card-title"><div><h2>Data preview</h2><p>Click a column heading to sort. Rows are paginated on the server.</p></div><span className="chart-mark bars"><Table2 size={17}/></span></div><div className="data-table-wrap">{tableLoading ? <p role="status">Loading preview?</p> : <table className="quality-table data-table"><thead><tr>{table?.columns.map(c => <th key={c} aria-sort={sort===c ? direction === "asc" ? "ascending" : "descending" : "none"}><button onClick={() => { setDirection(sort===c && direction==="asc" ? "desc" : "asc"); setSort(c); setPageNo(1); }}>{c}{sort===c ? direction==="asc" ? " ?" : " ?" : " ?"}</button></th>)}</tr></thead><tbody>{table?.rows.map((row,i) => <tr key={i}>{table.columns.map(c => <td key={c} title={String(row[c] ?? "")}>{row[c] == null || String(row[c]).trim() === "" ? <span className="missing-cell">Empty</span> : String(row[c])}</td>)}</tr>)}</tbody></table>}</div><div className="pagination"><span>{number(table?.total)} matching records</span><div><button aria-label="Previous page" disabled={tableLoading || pageNo<=1} onClick={() => setPageNo(p => p-1)}><ChevronLeft size={16}/></button><b>Page {table?.page || pageNo} of {table?.totalPages || 1}</b><button aria-label="Next page" disabled={tableLoading || pageNo >= (table?.totalPages || 1)} onClick={() => setPageNo(p => p+1)}><ChevronRight size={16}/></button></div></div></section>}
      <section className="report-note"><b>Method</b><div><p>All metrics are calculated locally from the selected worksheet and filters. No AI narrative or estimated statistics are included.</p>{summary.warnings.map(w => <p key={w}>{w}</p>)}</div></section>
    </>}
  </div>;
}
function Kpi({icon,label,value,tint,hint}) { return <article className="insight-kpi"><div className={`kpi-icon ${tint}`}>{icon}</div><div><span title={label}>{label}</span><strong>{value}</strong><small>{hint}</small></div></article>; }
function ChartCard({title,subtitle,mark,icon,className="",children}) { return <div className={`insight-card chart-card ${className}`}><div className="insight-card-title"><div><h2>{title}</h2><p>{subtitle}</p></div><span className={`chart-mark ${mark}`}>{icon}</span></div>{children}</div>; }
function ChartEmpty({text}) { return <div className="chart-empty"><div><BarChart3 size={21}/></div><span>{text}</span></div>; }
