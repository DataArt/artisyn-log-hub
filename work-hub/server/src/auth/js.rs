//! Small JavaScript semantics the auth ports rely on, so the Rust code passes the same rows as Log
//! Hub's TypeScript: `String.prototype.trim`, the `\s` class, `Number(string)` and
//! `Number.isInteger`.

/// JavaScript's `WhiteSpace` + `LineTerminator` set (what `trim()` strips and `\s` matches).
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'..='\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

/// `s.trim()`.
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

/// `/\s/.test(s)`.
pub fn has_whitespace(s: &str) -> bool {
    s.chars().any(is_js_whitespace)
}

/// `true` when the value is unset, `""` or only whitespace.
pub fn is_blank(v: Option<&str>) -> bool {
    v.is_none_or(|s| trim(s).is_empty())
}

/// `Number(s)` for a string: surrounding whitespace ignored, `""` is 0, `0x`/`0o`/`0b` prefixes,
/// `Infinity`, decimals with an optional sign, fraction and exponent; anything else is `NaN`.
pub fn number(s: &str) -> f64 {
    let t = trim(s);
    if t.is_empty() {
        return 0.0;
    }
    for (prefixes, radix) in [(["0x", "0X"], 16u32), (["0o", "0O"], 8), (["0b", "0B"], 2)] {
        for p in prefixes {
            if let Some(rest) = t.strip_prefix(p) {
                return parse_radix(rest, radix);
            }
        }
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    if !is_decimal_literal(t) {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// `Number.isInteger(x)`.
pub fn is_integer(x: f64) -> bool {
    x.is_finite() && x.trunc() == x
}

fn parse_radix(digits: &str, radix: u32) -> f64 {
    if digits.is_empty() {
        return f64::NAN;
    }
    let mut value = 0f64;
    for c in digits.chars() {
        match c.to_digit(radix) {
            Some(d) => value = value * f64::from(radix) + f64::from(d),
            None => return f64::NAN,
        }
    }
    value
}

/// `StrDecimalLiteral`: `[+-]? (digits [. digits?] | . digits) ([eE] [+-]? digits)?`.
fn is_decimal_literal(t: &str) -> bool {
    let b = t.as_bytes();
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let int_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let int_digits = i - int_start;
    let mut frac_digits = 0;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let frac_start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        frac_digits = i - frac_start;
    }
    if int_digits == 0 && frac_digits == 0 {
        return false;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let exp_start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == exp_start {
            return false;
        }
    }
    i == b.len()
}

/// `Math.ceil(ms / 1000)` for a non-negative millisecond count.
pub fn ceil_secs(ms: u64) -> u64 {
    ms.div_ceil(1000)
}
