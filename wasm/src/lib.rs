use chrono::{DateTime, Utc};
use js_sys::Array;
#[cfg(target_arch = "wasm32")]
use reqwest::header::{ACCEPT, CONTENT_LENGTH, CONTENT_RANGE, RANGE};
use serde::{Deserialize, Serialize};
#[cfg(target_arch = "wasm32")]
use std::cell::{Cell, RefCell};
use std::fmt::Write;
#[cfg(target_arch = "wasm32")]
use std::rc::Rc;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

#[wasm_bindgen]
pub struct LogParser {
    pending: Vec<u8>,
    pending_offset: u64,
    discard_first_line: bool,
}

#[wasm_bindgen]
pub struct LogSource {
    #[cfg(target_arch = "wasm32")]
    source_url: String,
    #[cfg(target_arch = "wasm32")]
    backscroll: bool,
    #[cfg(target_arch = "wasm32")]
    fetched: Rc<RefCell<Option<LogData>>>,
}

#[wasm_bindgen]
pub struct LogView {
    #[cfg(target_arch = "wasm32")]
    fetched: Rc<RefCell<Option<LogData>>>,
    #[cfg(target_arch = "wasm32")]
    start: Cell<Option<u64>>,
    #[cfg(target_arch = "wasm32")]
    wrap_columns: Cell<u32>,
}

#[derive(Clone, Debug)]
pub struct JSDateTime {
    pub dt: DateTime<Utc>,
}

impl Serialize for JSDateTime {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_i64(self.dt.timestamp_millis())
    }
}

impl Into<DateTime<Utc>> for JSDateTime {
    fn into(self) -> DateTime<Utc> {
        self.dt
    }
}

impl From<DateTime<Utc>> for JSDateTime {
    fn from(value: DateTime<Utc>) -> Self {
        JSDateTime { dt: value }
    }
}

#[derive(Clone, Serialize, Debug)]
pub enum LogElement {
    Line(JSDateTime, String, u64),
    Group(JSDateTime, String, Vec<LogElement>),
}

#[cfg(target_arch = "wasm32")]
#[derive(Serialize)]
struct RenderedLog {
    chunks: Vec<RenderedChunk>,
    complete: bool,
    #[serde(rename = "wrapColumns")]
    wrap_columns: u32,
}

#[derive(Serialize)]
struct RenderedChunk {
    html: String,
    rows: usize,
    #[serde(rename = "estimatedHeight")]
    estimated_height: usize,
}

#[cfg(target_arch = "wasm32")]
struct LogData {
    elements: Vec<LogElement>,
    start: u64,
    line_number_start: Option<u64>,
    line_ids: std::collections::HashSet<String>,
}

#[cfg(target_arch = "wasm32")]
struct ContentRange {
    start: u64,
    length: u64,
    complete: bool,
}

#[cfg(target_arch = "wasm32")]
#[derive(Deserialize)]
struct BackscrollResponse {
    lines: Vec<BackscrollLine>,
}

#[cfg(target_arch = "wasm32")]
#[derive(Deserialize)]
struct LiveLogEvent {
    lines: Vec<LiveLogLine>,
}

#[cfg(any(target_arch = "wasm32", test))]
#[derive(Deserialize)]
struct LiveLogLine {
    #[serde(rename = "lineID")]
    line_id: String,
    line: String,
}

#[derive(Deserialize)]
struct BackscrollLine {
    id: String,
    line: String,
}

#[cfg(target_arch = "wasm32")]
const LOG_RANGE_BYTES: u64 = 2 * 1024 * 1024;

fn backscroll_elements(lines: &[BackscrollLine]) -> Vec<LogElement> {
    lines
        .iter()
        .enumerate()
        .map(|(index, line)| {
            let timestamp = line
                .id
                .split_once('-')
                .and_then(|(timestamp, _)| timestamp.parse::<i64>().ok())
                .and_then(DateTime::<Utc>::from_timestamp_millis);
            let text = timestamp
                .map(|timestamp| {
                    format!(
                        "{} {}",
                        timestamp.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                        line.line,
                    )
                })
                .unwrap_or_else(|| line.line.clone());
            LogParser::parse_line(&text, index as u64)
        })
        .collect()
}

fn backscroll_line_number(line: &BackscrollLine) -> Option<u64> {
    line.id
        .split_once('-')
        .and_then(|(_, line_number)| line_number.parse().ok())
}

#[cfg(any(target_arch = "wasm32", test))]
fn deduplicate_live_lines(
    line_ids: &mut std::collections::HashSet<String>,
    lines: Vec<LiveLogLine>,
) -> Vec<BackscrollLine> {
    let mut lines = lines
        .into_iter()
        .filter_map(|line| {
            line_ids
                .insert(line.line_id.clone())
                .then_some(BackscrollLine {
                    id: line.line_id,
                    line: line.line,
                })
        })
        .collect::<Vec<_>>();
    lines.sort_by_key(backscroll_line_number);
    lines
}

#[wasm_bindgen]
impl LogParser {
    #[wasm_bindgen(constructor)]
    pub fn new(discard_first_line: bool) -> Self {
        Self::with_offset(discard_first_line, 0)
    }

    fn with_offset(discard_first_line: bool, pending_offset: u64) -> Self {
        Self {
            pending: Vec::new(),
            pending_offset,
            discard_first_line,
        }
    }

    /// Accepts the next chunk from a browser ReadableStream and returns the
    /// completed lines in that chunk as escaped, ANSI-formatted HTML.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Array, JsValue> {
        self.push_lines(chunk)
            .map_err(|x: String| JsValue::from_str(&x))
            .and_then(lines_to_jsvalue)
    }

    /// Flushes the final unterminated line after the stream reaches EOF.
    pub fn finish(&mut self) -> Result<Array, JsValue> {
        self.finish_lines()
            .map_err(|x: String| JsValue::from_str(&x))
            .and_then(lines_to_jsvalue)
    }
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl LogSource {
    #[wasm_bindgen(constructor)]
    pub fn new(source_url: String, backscroll: bool) -> Self {
        let fetched = backscroll.then(|| LogData {
            elements: Vec::new(),
            start: 0,
            line_number_start: None,
            line_ids: std::collections::HashSet::new(),
        });
        Self {
            source_url,
            backscroll,
            fetched: Rc::new(RefCell::new(fetched)),
        }
    }

    pub fn create_view(&self, wrap_columns: u32) -> LogView {
        LogView {
            fetched: Rc::clone(&self.fetched),
            start: Cell::new(None),
            wrap_columns: Cell::new(wrap_columns.max(40)),
        }
    }

    pub async fn fetch(&self) -> Result<(), JsValue> {
        if self.backscroll {
            return self.fetch_backscroll().await;
        }

        // Azure's Actions log endpoint does not reliably honor suffix ranges.
        // Probe from byte zero for the total length, then fetch an explicit tail.
        let (front_range, front_bytes) =
            fetch_log_range(&self.source_url, format!("bytes=0-{}", LOG_RANGE_BYTES - 1)).await?;
        let length = if front_range.length == 0 {
            front_bytes.len() as u64
        } else {
            front_range.length
        };

        let (range, bytes) = if front_range.complete {
            (front_range, front_bytes)
        } else {
            if length == 0 {
                return Err(JsValue::from_str(
                    "Log range response did not provide a total length",
                ));
            }
            fetch_log_range(
                &self.source_url,
                format!(
                    "bytes={}-{}",
                    length.saturating_sub(LOG_RANGE_BYTES),
                    length - 1
                ),
            )
            .await?
        };
        let mut parser = LogParser::with_offset(range.start > 0, range.start);
        let mut elements = parser
            .push_lines(&bytes)
            .map_err(|error| JsValue::from_str(&error))?;
        elements.extend(
            parser
                .finish_lines()
                .map_err(|error| JsValue::from_str(&error))?,
        );
        *self.fetched.borrow_mut() = Some(LogData {
            elements,
            start: range.start,
            line_number_start: None,
            line_ids: std::collections::HashSet::new(),
        });
        Ok(())
    }

    pub async fn fetch_previous(&self) -> Result<(), JsValue> {
        if self.backscroll {
            return Ok(());
        }
        let current_start = self
            .fetched
            .borrow()
            .as_ref()
            .ok_or_else(|| JsValue::from_str("Log source has not fetched a range"))?
            .start;
        if current_start == 0 {
            return Ok(());
        }

        let range_end = current_start - 1;
        let range_start = range_end.saturating_sub(LOG_RANGE_BYTES - 1);
        let (range, bytes) =
            fetch_log_range(&self.source_url, format!("bytes={range_start}-{range_end}")).await?;
        let mut parser = LogParser::with_offset(range.start > 0, range.start);
        // The final bytes continue the partial line discarded from the current
        // range, so do not flush this parser's trailing line.
        let elements = parser
            .push_lines(&bytes)
            .map_err(|error| JsValue::from_str(&error))?;
        let mut fetched_ref = self.fetched.borrow_mut();
        let fetched = fetched_ref.as_mut().expect("checked above");
        fetched.elements.splice(0..0, elements);
        fetched.start = range.start;
        Ok(())
    }

    async fn fetch_backscroll(&self) -> Result<(), JsValue> {
        let response = reqwest::Client::new()
            .get(&self.source_url)
            .header(ACCEPT, "application/json")
            .fetch_credentials_include()
            .send()
            .await
            .map_err(request_error)?;
        if !response.status().is_success() {
            return Err(JsValue::from_str(&format!(
                "Backscroll request failed with HTTP {}",
                response.status()
            )));
        }

        let response = response
            .json::<BackscrollResponse>()
            .await
            .map_err(request_error)?;
        let line_ids = response.lines.iter().map(|line| line.id.clone()).collect();
        *self.fetched.borrow_mut() = Some(LogData {
            elements: backscroll_elements(&response.lines),
            start: 0,
            line_number_start: response.lines.first().and_then(backscroll_line_number),
            line_ids,
        });
        Ok(())
    }

    pub fn append_live(&self, event: JsValue) -> Result<bool, JsValue> {
        let event = serde_wasm_bindgen::from_value::<LiveLogEvent>(event)
            .map_err(|error| JsValue::from_str(&format!("Invalid live log event: {error}")))?;
        let mut fetched_ref = self.fetched.borrow_mut();
        let fetched = fetched_ref
            .as_mut()
            .expect("live events are appended after the initial fetch");
        let lines = deduplicate_live_lines(&mut fetched.line_ids, event.lines);
        if lines.is_empty() {
            return Ok(false);
        }
        if fetched.line_number_start.is_none() {
            fetched.line_number_start = lines.first().and_then(backscroll_line_number);
        }
        fetched.elements.extend(backscroll_elements(&lines));
        Ok(true)
    }
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl LogView {
    pub fn initialize_window(&self) -> Result<JsValue, JsValue> {
        if self.start.get().is_none() {
            let fetched = self.fetched.borrow();
            let start = fetched
                .as_ref()
                .ok_or_else(|| JsValue::from_str("Log source has not fetched a range"))?
                .start;
            self.start.set(Some(start));
        }
        self.render()
    }

    pub fn expand_to_source_start(&self) -> Result<JsValue, JsValue> {
        let fetched = self.fetched.borrow();
        let start = fetched
            .as_ref()
            .ok_or_else(|| JsValue::from_str("Log source has not fetched a range"))?
            .start;
        self.start.set(Some(start));
        drop(fetched);
        self.render()
    }

    pub fn set_wrap_columns(&self, wrap_columns: u32) -> Result<JsValue, JsValue> {
        self.wrap_columns.set(wrap_columns.max(40));
        self.render()
    }

    pub fn render_current(&self) -> Result<JsValue, JsValue> {
        self.render()
    }
}

#[cfg(target_arch = "wasm32")]
impl LogView {
    fn render(&self) -> Result<JsValue, JsValue> {
        let fetched_ref = self.fetched.borrow();
        let fetched = fetched_ref
            .as_ref()
            .ok_or_else(|| JsValue::from_str("Log source has not fetched a range"))?;
        let start = self.start.get().unwrap_or(fetched.start);
        let wrap_columns = self.wrap_columns.get();
        let complete = fetched
            .line_number_start
            .map_or(start == 0, |line_number| line_number == 1);
        let line_number_start = fetched.line_number_start.or_else(|| complete.then_some(1));
        serde_wasm_bindgen::to_value(&RenderedLog {
            chunks: render_chunks_from(
                &fetched.elements,
                start,
                wrap_columns as usize,
                line_number_start,
            ),
            complete,
            wrap_columns,
        })
        .map_err(|error| JsValue::from_str(&format!("Failed to serialize rendered log: {error}")))
    }
}

#[cfg(target_arch = "wasm32")]
async fn fetch_log_range(
    log_url: &str,
    range_value: String,
) -> Result<(ContentRange, Vec<u8>), JsValue> {
    let response = reqwest::Client::new()
        .get(log_url)
        .header(RANGE, range_value)
        .fetch_credentials_include()
        .send()
        .await
        .map_err(request_error)?;

    if !response.status().is_success() {
        return Err(JsValue::from_str(&format!(
            "Log request failed with HTTP {}",
            response.status()
        )));
    }

    let range = content_range(&response)?;
    let bytes = response.bytes().await.map_err(request_error)?.to_vec();
    Ok((range, bytes))
}

#[cfg(target_arch = "wasm32")]
fn content_range(response: &reqwest::Response) -> Result<ContentRange, JsValue> {
    let fallback_length = || {
        response
            .headers()
            .get(CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0)
    };

    let Some(value) = response.headers().get(CONTENT_RANGE) else {
        return Ok(ContentRange {
            start: 0,
            length: fallback_length(),
            complete: response.status() == reqwest::StatusCode::OK,
        });
    };
    let value = value
        .to_str()
        .map_err(|error| JsValue::from_str(&format!("Invalid Content-Range header: {error}")))?;
    let Some(range) = value.strip_prefix("bytes ") else {
        return Ok(ContentRange {
            start: 0,
            length: fallback_length(),
            complete: false,
        });
    };
    let Some((range, total)) = range.split_once('/') else {
        return Ok(ContentRange {
            start: 0,
            length: fallback_length(),
            complete: false,
        });
    };
    let Some((start, end)) = range.split_once('-') else {
        return Ok(ContentRange {
            start: 0,
            length: fallback_length(),
            complete: false,
        });
    };

    let start = start
        .parse::<u64>()
        .map_err(|error| JsValue::from_str(&format!("Invalid range start: {error}")))?;
    let end = end
        .parse::<u64>()
        .map_err(|error| JsValue::from_str(&format!("Invalid range end: {error}")))?;
    let total = total
        .parse::<u64>()
        .map_err(|error| JsValue::from_str(&format!("Invalid range length: {error}")))?;
    Ok(ContentRange {
        start,
        length: total,
        complete: start == 0 && end.checked_add(1) == Some(total),
    })
}

#[cfg(target_arch = "wasm32")]
fn request_error(error: reqwest::Error) -> JsValue {
    JsValue::from_str(&format!("Log request failed: {error}"))
}

impl LogParser {
    fn fallback_date() -> DateTime<Utc> {
        DateTime::from_timestamp_millis(0).expect("unix epoch is a valid timestamp")
    }

    fn parse_line(text: &str, byte_offset: u64) -> LogElement {
        let text = text.strip_prefix('\u{feff}').unwrap_or(text);
        let (date, raw_text) = text
            .split_once(char::is_whitespace)
            .and_then(|(raw_date, raw_text)| {
                chrono::DateTime::parse_from_rfc3339(raw_date)
                    .ok()
                    // split_once consumed the single timestamp separator.
                    // Everything after it is log content, including spaces.
                    .map(|date| (date.with_timezone(&Utc), raw_text))
            })
            // Non-timestamped lines are valid GitHub Actions output. Do not
            // log a warning per line: a 2MB range can otherwise flood the
            // console and starve the page.
            .unwrap_or_else(|| (Self::fallback_date(), text));

        let html = ansi_to_html::convert(&raw_text)
            .unwrap_or_else(|_| html_escape::encode_text(raw_text).to_string());
        LogElement::Line(date.into(), html, byte_offset)
    }

    fn push_lines(&mut self, chunk: &[u8]) -> Result<Vec<LogElement>, String> {
        self.pending.extend_from_slice(chunk);

        let Some(last_newline) = self.pending.iter().rposition(|byte| *byte == b'\n') else {
            return Ok(Vec::new());
        };

        let complete = self.pending.drain(..=last_newline).collect::<Vec<_>>();
        let offset = self.pending_offset;
        self.pending_offset += complete.len() as u64;
        self.convert_lines(&complete, false, offset)
    }

    fn finish_lines(&mut self) -> Result<Vec<LogElement>, String> {
        let remaining = std::mem::take(&mut self.pending);
        let offset = self.pending_offset;
        self.pending_offset += remaining.len() as u64;
        self.convert_lines(&remaining, true, offset)
    }

    fn convert_lines(
        &mut self,
        bytes: &[u8],
        include_trailing_line: bool,
        byte_offset: u64,
    ) -> Result<Vec<LogElement>, String> {
        if bytes.is_empty() {
            return Ok(Vec::new());
        }

        let mut output = Vec::new();
        let mut consumed = 0_u64;

        for line in bytes.split_inclusive(|byte| *byte == b'\n') {
            if !line.ends_with(b"\n") && !include_trailing_line {
                break;
            }

            let line_offset = byte_offset + consumed;
            consumed += line.len() as u64;
            let raw_line = line.strip_suffix(b"\n").unwrap_or(line);

            if self.discard_first_line {
                self.discard_first_line = false;
                continue;
            }

            let raw_line = raw_line.strip_suffix(b"\r").unwrap_or(raw_line);
            let text = String::from_utf8_lossy(raw_line);
            let element = Self::parse_line(&text, line_offset);

            output.push(element);
        }

        Ok(output)
    }
}

const LOG_CHUNK_ROWS: usize = 200;

#[cfg(test)]
fn render_chunks(elements: &[LogElement], wrap_columns: usize) -> Vec<RenderedChunk> {
    render_chunks_from(elements, 0, wrap_columns, Some(1))
}

fn render_chunks_from(
    elements: &[LogElement],
    start_offset: u64,
    wrap_columns: usize,
    line_number_start: Option<u64>,
) -> Vec<RenderedChunk> {
    let mut chunks = Vec::new();
    let mut html = String::new();
    let mut rows = 0;
    let mut estimated_height = 0;
    let wrap_columns = wrap_columns.max(40);
    let mut line_number = line_number_start;

    let mut append = |timestamp: &JSDateTime, line_html: &str, byte_offset: u64| {
        let visible_columns = html_visible_columns(line_html);
        let estimated_visual_rows = visible_columns.div_ceil(wrap_columns).max(1);
        let wraps = estimated_visual_rows > 1;
        let timestamp = if timestamp.dt.timestamp_millis() != 0 {
            timestamp
                .dt
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        } else {
            String::new()
        };
        let gutter = line_number
            .map(|line_number| line_number.to_string())
            .unwrap_or_else(|| format!("B{byte_offset}"));
        if let Some(line_number) = line_number.as_mut() {
            *line_number += 1;
        }
        let wrap_class = if wraps { " gha-log-line--wrap" } else { "" };
        let _ = write!(
            html,
            "<div class=\"gha-log-line{wrap_class}\" data-offset=\"{gutter}\"><span class=\"gha-log-timestamp\">{timestamp}</span><span class=\"gha-log-content\">{line_html}</span></div>"
        );
        rows += 1;
        estimated_height += estimated_visual_rows * 18;
        if rows == LOG_CHUNK_ROWS {
            chunks.push(RenderedChunk {
                html: std::mem::take(&mut html),
                rows,
                estimated_height,
            });
            rows = 0;
            estimated_height = 0;
        }
    };

    fn visit(
        elements: &[LogElement],
        start_offset: u64,
        append: &mut impl FnMut(&JSDateTime, &str, u64),
    ) {
        for element in elements {
            match element {
                LogElement::Line(timestamp, html, byte_offset) if *byte_offset >= start_offset => {
                    append(timestamp, html, *byte_offset)
                }
                LogElement::Line(_, _, _) => {}
                LogElement::Group(_, _, children) => visit(children, start_offset, append),
            }
        }
    }

    visit(elements, start_offset, &mut append);
    if rows != 0 {
        chunks.push(RenderedChunk {
            html,
            rows,
            estimated_height,
        });
    }
    chunks
}

/// Counts visible text columns in the controlled inline HTML emitted by
/// ansi-to-html. Tags are zero-width and escaped entities occupy one column.
fn html_visible_columns(html: &str) -> usize {
    let mut columns = 0;
    let mut cursor = 0;

    while cursor < html.len() {
        let remainder = &html[cursor..];
        if remainder.starts_with('<') {
            let Some(end) = remainder.find('>') else {
                break;
            };
            let tag = &remainder[..=end];
            cursor += tag.len();
            continue;
        }

        let unit = if remainder.starts_with('&') {
            if let Some(end) = remainder.find(';') {
                &remainder[..=end]
            } else {
                &remainder[..1]
            }
        } else {
            let character = remainder.chars().next().expect("cursor is in bounds");
            &remainder[..character.len_utf8()]
        };
        columns += 1;
        cursor += unit.len();
    }
    columns
}

fn lines_to_jsvalue<T>(lines: Vec<T>) -> Result<Array, JsValue>
where
    T: Serialize,
{
    Ok(serde_wasm_bindgen::to_value(&lines)
        .unwrap_or_else(|_| Array::new().into())
        .dyn_into::<Array>()
        .unwrap())
}

#[wasm_bindgen(start)]
pub fn init() {
    std::panic::set_hook(Box::new(console_error_panic_hook::hook));
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn buffers_partial_lines() {
        let mut parser = LogParser::new(false);
        assert!(parser.push_lines(b"hel").unwrap().is_empty());

        let lines = parser.push_lines(b"lo\nworld").unwrap();
        assert!(matches!(lines.as_slice(), [LogElement::Line(_, s, 0)] if s == "hello"));

        let lines = parser.finish_lines().unwrap();
        assert!(matches!(lines.as_slice(), [LogElement::Line(_, s, 6)] if s == "world"));
    }

    #[test]
    fn discards_a_partial_range_line() {
        let mut parser = LogParser::with_offset(true, 100);
        let lines = parser.push_lines(b"partial\n\x1b[31mred\x1b[0m\n").unwrap();
        assert!(matches!(lines.as_slice(), [LogElement::Line(_, s, 108)] if s.contains("red")));
        assert!(parser.finish_lines().unwrap().is_empty());
    }

    #[test]
    fn parses_bom_prefixed_timestamp() {
        let LogElement::Line(ts, text, byte_offset) =
            LogParser::parse_line("\u{feff}2026-05-17T06:16:09.07823Z   hello", 42)
        else {
            panic!("Nope");
        };
        assert_eq!(
            Into::<DateTime<Utc>>::into(ts).timestamp_millis(),
            1_778_998_569_078
        );
        assert_eq!(text, "  hello");
        assert_eq!(byte_offset, 42);
    }

    #[test]
    fn keeps_non_timestamped_output_without_logging() {
        let LogElement::Line(timestamp, text, byte_offset) =
            LogParser::parse_line("plain output", 7)
        else {
            panic!("Nope");
        };
        assert_eq!(Into::<DateTime<Utc>>::into(timestamp).timestamp_millis(), 0);
        assert_eq!(text, "plain output");
        assert_eq!(byte_offset, 7);
    }

    #[test]
    fn preserves_backscroll_timestamp_and_starting_line_number() {
        let response = [
            BackscrollLine {
                id: "1786507993989-417".into(),
                line: "\x1b[36;1mdocker run \\\x1b[0m".into(),
            },
            BackscrollLine {
                id: "invalid".into(),
                line: "plain output".into(),
            },
        ];
        let lines = backscroll_elements(&response);

        let [LogElement::Line(timestamp, text, 0), LogElement::Line(fallback, plain, 1)] =
            lines.as_slice()
        else {
            panic!("unexpected backscroll parse result");
        };
        assert_eq!(timestamp.dt.timestamp_millis(), 1_786_507_993_989);
        assert!(text.contains("docker run"));
        assert_eq!(fallback.dt.timestamp_millis(), 0);
        assert_eq!(plain, "plain output");
        assert_eq!(backscroll_line_number(&response[0]), Some(417));
        let chunks = render_chunks_from(&lines, 0, 80, Some(417));
        assert!(chunks[0].html.contains("data-offset=\"417\""));
        assert!(chunks[0].html.contains("data-offset=\"418\""));
    }

    #[test]
    fn deduplicates_and_orders_live_lines() {
        let mut line_ids = std::collections::HashSet::from(["1786507993989-41".into()]);
        let lines = deduplicate_live_lines(
            &mut line_ids,
            vec![
                LiveLogLine {
                    line_id: "1786507993989-43".into(),
                    line: "third".into(),
                },
                LiveLogLine {
                    line_id: "1786507993989-41".into(),
                    line: "duplicate".into(),
                },
                LiveLogLine {
                    line_id: "1786507993989-42".into(),
                    line: "second".into(),
                },
            ],
        );

        assert_eq!(lines.len(), 2);
        assert_eq!(backscroll_line_number(&lines[0]), Some(42));
        assert_eq!(backscroll_line_number(&lines[1]), Some(43));
        assert!(line_ids.contains("1786507993989-41"));
        assert!(line_ids.contains("1786507993989-42"));
        assert!(line_ids.contains("1786507993989-43"));
    }

    #[test]
    fn counts_visible_html_columns() {
        assert_eq!(
            html_visible_columns("<span style='color:var(--red,#a00)'>&lt;abc&gt;</span>"),
            5,
        );
    }

    #[test]
    fn marks_long_lines_for_browser_wrapping() {
        let line = LogElement::Line(
            JSDateTime::from(DateTime::from_timestamp_millis(1).unwrap()),
            "a".repeat(41),
            99,
        );
        let chunks = render_chunks(&[line], 40);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].rows, 1);
        assert_eq!(chunks[0].estimated_height, 36);
        assert!(chunks[0].html.contains("data-offset=\"1\""));
        assert!(chunks[0].html.contains("gha-log-line--wrap"));
    }

    #[test]
    fn numbers_lines_across_render_chunks() {
        let timestamp = JSDateTime::from(DateTime::from_timestamp_millis(1).unwrap());
        let lines = (0..201)
            .map(|offset| LogElement::Line(timestamp.clone(), "line".into(), offset))
            .collect::<Vec<_>>();

        let chunks = render_chunks_from(&lines, 0, 80, Some(417));
        assert_eq!(chunks.len(), 2);
        assert!(chunks[0].html.contains("data-offset=\"616\""));
        assert!(chunks[1].html.contains("data-offset=\"617\""));
    }

    #[test]
    fn renders_only_the_view_window() {
        let timestamp = JSDateTime::from(DateTime::from_timestamp_millis(1).unwrap());
        let lines = vec![
            LogElement::Line(timestamp.clone(), "old".into(), 10),
            LogElement::Line(timestamp, "current".into(), 20),
        ];

        let chunks = render_chunks_from(&lines, 20, 80, None);
        assert_eq!(chunks.len(), 1);
        assert!(!chunks[0].html.contains("old"));
        assert!(chunks[0].html.contains("current"));
        assert!(chunks[0].html.contains("data-offset=\"B20\""));
    }
}
