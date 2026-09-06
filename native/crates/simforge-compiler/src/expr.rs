//! Typed numeric expressions: the "speeds are expressions, not literals" rule.
//!
//! A template that says `65 kph` is wrong on a 25 mph street and wrong on a
//! motorway; `clamp(0.9 * lane.speedLimitKph, 25, 65)` transfers. Five node
//! kinds over a **closed registry of identifiers**: there is no evaluator of
//! arbitrary code, so a hostile or hallucinated expression can at worst be
//! rejected.
//!
//! Two serialised forms are accepted on input and one is stored:
//! - `"clamp(0.9 * lane.speedLimitKph, 25, 65)"` (authoring form, parsed here);
//! - `{kind: 'call', fn: 'clamp', args: [...]}` (stored AST form).
//!
//! Evaluation is total: it returns a finite number or an [`ExpressionError`].
//! Division by zero, an unbound identifier and overflow are errors, never a
//! `NaN` leaking into a solver.

use std::collections::BTreeMap;
use std::fmt;

use serde::de::{self, Deserializer};
use serde::ser::{SerializeMap, SerializeSeq, Serializer};
use serde::{Deserialize, Serialize};

/// Binary operators. `*` `/` bind tighter than `+` `-`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BinOp {
    #[serde(rename = "+")]
    Add,
    #[serde(rename = "-")]
    Sub,
    #[serde(rename = "*")]
    Mul,
    #[serde(rename = "/")]
    Div,
}

impl BinOp {
    fn precedence(self) -> u8 {
        match self {
            Self::Add | Self::Sub => 1,
            Self::Mul | Self::Div => 2,
        }
    }

    fn symbol(self) -> char {
        match self {
            Self::Add => '+',
            Self::Sub => '-',
            Self::Mul => '*',
            Self::Div => '/',
        }
    }
}

/// Callable functions. Deliberately tiny: everything here is total and pure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CallFn {
    Clamp,
    Min,
    Max,
    Abs,
}

impl CallFn {
    pub const ALL: [CallFn; 4] = [CallFn::Clamp, CallFn::Min, CallFn::Max, CallFn::Abs];

    pub fn name(self) -> &'static str {
        match self {
            Self::Clamp => "clamp",
            Self::Min => "min",
            Self::Max => "max",
            Self::Abs => "abs",
        }
    }

    fn from_name(name: &str) -> Option<Self> {
        match name {
            "clamp" => Some(Self::Clamp),
            "min" => Some(Self::Min),
            "max" => Some(Self::Max),
            "abs" => Some(Self::Abs),
            _ => None,
        }
    }

    /// `(min, max)`; `None` max means variadic.
    fn arity(self) -> (usize, Option<usize>) {
        match self {
            Self::Clamp => (3, Some(3)),
            Self::Min | Self::Max => (2, None),
            Self::Abs => (1, Some(1)),
        }
    }

    fn check_arity(self, n: usize) -> Result<(), String> {
        let (min, max) = self.arity();
        if n < min || max.is_some_and(|m| n > m) {
            return Err(match max {
                None => format!(
                    "{}() takes at least {} arguments, got {}",
                    self.name(),
                    min,
                    n
                ),
                Some(_) => format!(
                    "{}() takes exactly {} arguments, got {}",
                    self.name(),
                    min,
                    n
                ),
            });
        }
        Ok(())
    }
}

/// Every identifier an expression may name, other than `param.<name>`.
pub const EXPR_REFS: [&str; 4] = [
    "lane.speedLimitKph",
    "lane.widthM",
    "junction.sizeM",
    "clip.seconds",
];

/// `param.<ident>` — the one open namespace.
pub fn is_param_ref(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("param.") else {
        return false;
    };
    let mut chars = rest.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// True when `name` is a legal identifier (registry entry or `param.<ident>`).
pub fn is_known_ref(name: &str) -> bool {
    EXPR_REFS.contains(&name) || is_param_ref(name)
}

/// A numeric expression.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Expr {
    Num {
        value: f64,
    },
    Ref {
        name: String,
    },
    Neg {
        operand: Box<Expr>,
    },
    Bin {
        op: BinOp,
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Call {
        #[serde(rename = "fn")]
        func: CallFn,
        args: Vec<Expr>,
    },
}

/// Thrown by the parser and the evaluator. Carries a 0-based column when parsing.
#[derive(Debug, Clone, PartialEq)]
pub struct ExpressionError {
    pub message: String,
    pub column: Option<usize>,
}

impl ExpressionError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            column: None,
        }
    }

    fn at(message: impl Into<String>, column: usize) -> Self {
        Self {
            message: message.into(),
            column: Some(column),
        }
    }

    /// True for "cannot know yet": an identifier that has no value in the
    /// evaluation scope, as opposed to a genuinely wrong expression.
    pub fn is_unbound(&self) -> bool {
        self.message.contains("is not bound in this scope") || self.message.contains("has no value")
    }
}

impl fmt::Display for ExpressionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.column {
            Some(c) => write!(f, "{} (at column {})", self.message, c + 1),
            None => f.write_str(&self.message),
        }
    }
}

impl std::error::Error for ExpressionError {}

/* ---------------------------------------------------------------- parsing */

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Num(f64, usize),
    Ident(String, usize),
    Op(char, usize),
    Eof(usize),
}

impl Token {
    fn at(&self) -> usize {
        match self {
            Token::Num(_, at) | Token::Ident(_, at) | Token::Op(_, at) | Token::Eof(at) => *at,
        }
    }
}

fn tokenize(source: &str) -> Result<Vec<Token>, ExpressionError> {
    let bytes = source.as_bytes();
    let mut tokens = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        let c = bytes[i] as char;
        if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
            i += 1;
            continue;
        }
        if "+-*/(),".contains(c) {
            tokens.push(Token::Op(c, i));
            i += 1;
            continue;
        }
        if c.is_ascii_digit() {
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            if i < bytes.len() && bytes[i] == b'.' {
                i += 1;
                while i < bytes.len() && bytes[i].is_ascii_digit() {
                    i += 1;
                }
            }
            if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
                let save = i;
                i += 1;
                if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
                    i += 1;
                }
                if i < bytes.len() && bytes[i].is_ascii_digit() {
                    while i < bytes.len() && bytes[i].is_ascii_digit() {
                        i += 1;
                    }
                } else {
                    i = save;
                }
            }
            let text = &source[start..i];
            let value: f64 = text
                .parse()
                .map_err(|_| ExpressionError::at(format!("bad number \"{text}\""), start))?;
            if !value.is_finite() {
                return Err(ExpressionError::at(format!("bad number \"{text}\""), start));
            }
            tokens.push(Token::Num(value, start));
            continue;
        }
        if c.is_ascii_alphabetic() || c == '_' {
            let start = i;
            while i < bytes.len()
                && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_' || bytes[i] == b'.')
            {
                i += 1;
            }
            tokens.push(Token::Ident(source[start..i].to_owned(), start));
            continue;
        }
        let ch = source[i..].chars().next().unwrap_or(c);
        return Err(ExpressionError::at(
            format!("unexpected character \"{ch}\""),
            i,
        ));
    }
    tokens.push(Token::Eof(source.len()));
    Ok(tokens)
}

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
}

impl Parser {
    fn peek(&self) -> &Token {
        &self.tokens[self.pos]
    }

    fn next(&mut self) -> Token {
        let token = self.tokens[self.pos].clone();
        if !matches!(token, Token::Eof(_)) {
            self.pos += 1;
        }
        token
    }

    fn eat_op(&mut self, value: char) -> bool {
        if let Token::Op(c, _) = self.peek() {
            if *c == value {
                self.pos += 1;
                return true;
            }
        }
        false
    }

    fn expect_op(&mut self, value: char) -> Result<(), ExpressionError> {
        match self.peek() {
            Token::Op(c, _) if *c == value => {
                self.pos += 1;
                Ok(())
            }
            other => Err(ExpressionError::at(
                format!("expected \"{value}\""),
                other.at(),
            )),
        }
    }

    fn parse_top(&mut self) -> Result<Expr, ExpressionError> {
        let expr = self.parse_expr()?;
        match self.peek() {
            Token::Eof(_) => Ok(expr),
            Token::Op(c, at) => Err(ExpressionError::at(
                format!("unexpected trailing input \"{c}\""),
                *at,
            )),
            Token::Num(v, at) => Err(ExpressionError::at(
                format!("unexpected trailing input \"{v}\""),
                *at,
            )),
            Token::Ident(s, at) => Err(ExpressionError::at(
                format!("unexpected trailing input \"{s}\""),
                *at,
            )),
        }
    }

    fn parse_expr(&mut self) -> Result<Expr, ExpressionError> {
        let mut left = self.parse_term()?;
        loop {
            let op = match self.peek() {
                Token::Op('+', _) => BinOp::Add,
                Token::Op('-', _) => BinOp::Sub,
                _ => return Ok(left),
            };
            self.pos += 1;
            let right = self.parse_term()?;
            left = Expr::Bin {
                op,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
    }

    fn parse_term(&mut self) -> Result<Expr, ExpressionError> {
        let mut left = self.parse_unary()?;
        loop {
            let op = match self.peek() {
                Token::Op('*', _) => BinOp::Mul,
                Token::Op('/', _) => BinOp::Div,
                _ => return Ok(left),
            };
            self.pos += 1;
            let right = self.parse_unary()?;
            left = Expr::Bin {
                op,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
    }

    fn parse_unary(&mut self) -> Result<Expr, ExpressionError> {
        if self.eat_op('-') {
            return Ok(Expr::Neg {
                operand: Box::new(self.parse_unary()?),
            });
        }
        if self.eat_op('+') {
            return self.parse_unary();
        }
        self.parse_primary()
    }

    fn parse_primary(&mut self) -> Result<Expr, ExpressionError> {
        match self.next() {
            Token::Num(value, _) => Ok(Expr::Num { value }),
            Token::Op('(', _) => {
                let inner = self.parse_expr()?;
                self.expect_op(')')?;
                Ok(inner)
            }
            Token::Ident(name, at) => {
                let is_call = matches!(self.peek(), Token::Op('(', _));
                if is_call {
                    let Some(func) = CallFn::from_name(&name) else {
                        let known: Vec<&str> = CallFn::ALL.iter().map(|f| f.name()).collect();
                        return Err(ExpressionError::at(
                            format!("unknown function \"{name}\"; known: {}", known.join(", ")),
                            at,
                        ));
                    };
                    self.expect_op('(')?;
                    let mut args = vec![self.parse_expr()?];
                    while self.eat_op(',') {
                        args.push(self.parse_expr()?);
                    }
                    self.expect_op(')')?;
                    func.check_arity(args.len())
                        .map_err(|m| ExpressionError::at(m, at))?;
                    return Ok(Expr::Call { func, args });
                }
                if !is_known_ref(&name) {
                    return Err(ExpressionError::at(
                        format!("unknown identifier \"{name}\"; use param.<name> or a site fact"),
                        at,
                    ));
                }
                Ok(Expr::Ref { name })
            }
            other => Err(ExpressionError::at(
                "expected a number, identifier or \"(\"",
                other.at(),
            )),
        }
    }
}

/// Parse the string form into an AST.
pub fn parse_expr(source: &str) -> Result<Expr, ExpressionError> {
    if source.trim().is_empty() {
        return Err(ExpressionError::at("empty expression", 0));
    }
    let tokens = tokenize(source)?;
    Parser { tokens, pos: 0 }.parse_top()
}

/// Validate a stored AST: registry identifiers, call arity, finite literals.
pub fn validate_expr(expr: &Expr) -> Result<(), ExpressionError> {
    match expr {
        Expr::Num { value } => {
            if !value.is_finite() {
                return Err(ExpressionError::new("expression literal is not finite"));
            }
            Ok(())
        }
        Expr::Ref { name } => {
            if !is_known_ref(name) {
                return Err(ExpressionError::new(format!(
                    "unknown identifier \"{name}\"; known: {}, param.<name>",
                    EXPR_REFS.join(", ")
                )));
            }
            Ok(())
        }
        Expr::Neg { operand } => validate_expr(operand),
        Expr::Bin { left, right, .. } => {
            validate_expr(left)?;
            validate_expr(right)
        }
        Expr::Call { func, args } => {
            if args.is_empty() {
                return Err(ExpressionError::new(format!(
                    "{}() needs at least one argument",
                    func.name()
                )));
            }
            func.check_arity(args.len()).map_err(ExpressionError::new)?;
            args.iter().try_for_each(validate_expr)
        }
    }
}

/// Render an AST back to the string grammar. Parentheses are emitted where
/// precedence *or associativity* requires them, so `print(parse(s))` is a
/// normal form.
pub fn print_expr(expr: &Expr) -> String {
    match expr {
        Expr::Num { value } => simforge_core::hash::js_number_to_string(*value),
        Expr::Ref { name } => name.clone(),
        Expr::Neg { operand } => match **operand {
            Expr::Bin { .. } | Expr::Neg { .. } => format!("-({})", print_expr(operand)),
            _ => format!("-{}", print_expr(operand)),
        },
        Expr::Call { func, args } => {
            let rendered: Vec<String> = args.iter().map(print_expr).collect();
            format!("{}({})", func.name(), rendered.join(", "))
        }
        Expr::Bin { op, left, right } => {
            let me = op.precedence();
            let left_s = match **left {
                Expr::Bin { op: lop, .. } if lop.precedence() < me => {
                    format!("({})", print_expr(left))
                }
                _ => print_expr(left),
            };
            let right_s = match **right {
                Expr::Bin { op: rop, .. } if rop.precedence() <= me => {
                    format!("({})", print_expr(right))
                }
                _ => print_expr(right),
            };
            format!("{} {} {}", left_s, op.symbol(), right_s)
        }
    }
}

/// Walk every node, parents before children.
pub fn walk_expr<'a>(expr: &'a Expr, visit: &mut impl FnMut(&'a Expr)) {
    visit(expr);
    match expr {
        Expr::Neg { operand } => walk_expr(operand, visit),
        Expr::Bin { left, right, .. } => {
            walk_expr(left, visit);
            walk_expr(right, visit);
        }
        Expr::Call { args, .. } => args.iter().for_each(|a| walk_expr(a, visit)),
        Expr::Num { .. } | Expr::Ref { .. } => {}
    }
}

/// Every identifier the expression reads, sorted, deduplicated.
pub fn collect_refs(expr: &Expr) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    walk_expr(expr, &mut |node| {
        if let Expr::Ref { name } = node {
            out.push(name.clone());
        }
    });
    out.sort();
    out.dedup();
    out
}

/// Every `param.<name>` the expression reads, as bare param ids.
pub fn collect_param_refs(expr: &Expr) -> Vec<String> {
    collect_refs(expr)
        .into_iter()
        .filter_map(|n| n.strip_prefix("param.").map(str::to_owned))
        .collect()
}

/* ------------------------------------------------------------- evaluation */

/// Values available to [`evaluate_expr`]. Anything absent makes its ref unbound.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ExprScope {
    pub lane_speed_limit_kph: Option<f64>,
    pub lane_width_m: Option<f64>,
    pub junction_size_m: Option<f64>,
    pub clip_seconds: Option<f64>,
    pub params: BTreeMap<String, f64>,
}

impl ExprScope {
    pub fn with_lane(mut self, speed_limit_kph: Option<f64>, width_m: Option<f64>) -> Self {
        self.lane_speed_limit_kph = speed_limit_kph;
        self.lane_width_m = width_m;
        self
    }

    pub fn with_junction(mut self, size_m: Option<f64>) -> Self {
        self.junction_size_m = size_m;
        self
    }

    pub fn with_clip(mut self, seconds: Option<f64>) -> Self {
        self.clip_seconds = seconds;
        self
    }

    fn lookup(&self, name: &str) -> Result<f64, ExpressionError> {
        if let Some(id) = name.strip_prefix("param.") {
            return self
                .params
                .get(id)
                .copied()
                .ok_or_else(|| ExpressionError::new(format!("parameter \"{id}\" has no value")));
        }
        let value = match name {
            "lane.speedLimitKph" => self.lane_speed_limit_kph,
            "lane.widthM" => self.lane_width_m,
            "junction.sizeM" => self.junction_size_m,
            "clip.seconds" => self.clip_seconds,
            _ => None,
        };
        value.ok_or_else(|| ExpressionError::new(format!("\"{name}\" is not bound in this scope")))
    }
}

fn eval_node(expr: &Expr, scope: &ExprScope) -> Result<f64, ExpressionError> {
    match expr {
        Expr::Num { value } => Ok(*value),
        Expr::Ref { name } => scope.lookup(name),
        Expr::Neg { operand } => Ok(-eval_node(operand, scope)?),
        Expr::Bin { op, left, right } => {
            let a = eval_node(left, scope)?;
            let b = eval_node(right, scope)?;
            Ok(match op {
                BinOp::Add => a + b,
                BinOp::Sub => a - b,
                BinOp::Mul => a * b,
                BinOp::Div => {
                    if b == 0.0 {
                        return Err(ExpressionError::new("division by zero"));
                    }
                    a / b
                }
            })
        }
        Expr::Call { func, args } => {
            let mut values = Vec::with_capacity(args.len());
            for a in args {
                values.push(eval_node(a, scope)?);
            }
            Ok(match func {
                CallFn::Abs => values[0].abs(),
                CallFn::Min => values.iter().copied().fold(f64::INFINITY, js_min),
                CallFn::Max => values.iter().copied().fold(f64::NEG_INFINITY, js_max),
                CallFn::Clamp => {
                    let (x, lo, hi) = (values[0], values[1], values[2]);
                    if lo > hi {
                        return Err(ExpressionError::new(format!(
                            "clamp() lower bound {lo} exceeds upper bound {hi}"
                        )));
                    }
                    js_min(js_max(x, lo), hi)
                }
            })
        }
    }
}

/// `Math.min` propagates NaN; f64::min does not.
#[inline]
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

#[inline]
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

/// Evaluate an expression. Errors on an unbound identifier, division by zero
/// or a non-finite result.
pub fn evaluate_expr(expr: &Expr, scope: &ExprScope) -> Result<f64, ExpressionError> {
    let value = eval_node(expr, scope)?;
    if !value.is_finite() {
        return Err(ExpressionError::new("expression is not finite"));
    }
    Ok(value)
}

/// Result of a best-effort evaluation. `Indeterminate` means "needs a site".
#[derive(Debug, Clone, PartialEq)]
pub enum EvalOutcome {
    Value(f64),
    Indeterminate(String),
    Error(String),
}

/// Evaluate without failing, distinguishing "cannot know yet" from "wrong".
pub fn try_evaluate(value: &NumberOrExpr, scope: &ExprScope) -> EvalOutcome {
    match value.evaluate(scope) {
        Ok(v) => EvalOutcome::Value(v),
        Err(e) if e.is_unbound() => EvalOutcome::Indeterminate(e.to_string()),
        Err(e) => EvalOutcome::Error(e.to_string()),
    }
}

/* ----------------------------------------------------------- NumberOrExpr */

/// A number or an expression: the type of every speed, gap, offset, time and
/// threshold in schema v2. Deserialises from a finite number, an expression
/// string, or the stored AST; serialises as the number or the AST.
#[derive(Debug, Clone, PartialEq)]
pub enum NumberOrExpr {
    Number(f64),
    Expr(Expr),
}

impl NumberOrExpr {
    pub fn evaluate(&self, scope: &ExprScope) -> Result<f64, ExpressionError> {
        match self {
            Self::Number(v) => Ok(*v),
            Self::Expr(e) => evaluate_expr(e, scope),
        }
    }

    pub fn as_number(&self) -> Option<f64> {
        match self {
            Self::Number(v) => Some(*v),
            Self::Expr(_) => None,
        }
    }

    pub fn is_expr(&self) -> bool {
        matches!(self, Self::Expr(_))
    }

    pub fn as_expr(&self) -> Option<&Expr> {
        match self {
            Self::Expr(e) => Some(e),
            Self::Number(_) => None,
        }
    }

    pub fn param_refs(&self) -> Vec<String> {
        match self {
            Self::Number(_) => Vec::new(),
            Self::Expr(e) => collect_param_refs(e),
        }
    }
}

impl From<f64> for NumberOrExpr {
    fn from(value: f64) -> Self {
        Self::Number(value)
    }
}

impl Serialize for NumberOrExpr {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Number(v) => serializer.serialize_f64(*v),
            Self::Expr(e) => e.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for NumberOrExpr {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        number_or_expr_from_value(&value).map_err(de::Error::custom)
    }
}

/// Decode a `number | string | AST` JSON value.
pub fn number_or_expr_from_value(value: &serde_json::Value) -> Result<NumberOrExpr, String> {
    match value {
        serde_json::Value::Number(n) => {
            let v = n
                .as_f64()
                .ok_or_else(|| "number is not representable".to_owned())?;
            if !v.is_finite() {
                return Err("number must be finite".to_owned());
            }
            Ok(NumberOrExpr::Number(v))
        }
        serde_json::Value::String(source) => parse_expr(source)
            .map(NumberOrExpr::Expr)
            .map_err(|e| e.to_string()),
        serde_json::Value::Object(_) => {
            let expr: Expr = serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
            validate_expr(&expr).map_err(|e| e.to_string())?;
            Ok(NumberOrExpr::Expr(expr))
        }
        _ => Err("expected a number, an expression string or an expression AST".to_owned()),
    }
}

/// An expression-only field (`derived` params, `tFrac` expressions): the
/// string form or the AST, never a bare number.
#[derive(Debug, Clone, PartialEq)]
pub struct ExprField(pub Expr);

impl Serialize for ExprField {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for ExprField {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        match number_or_expr_from_value(&value).map_err(de::Error::custom)? {
            NumberOrExpr::Expr(e) => Ok(Self(e)),
            NumberOrExpr::Number(_) => {
                Err(de::Error::custom("expected an expression, not a number"))
            }
        }
    }
}

/// Serialise a `[f64]` slice as a JSON array (helper for callers building
/// typed wire shapes by hand).
pub fn serialize_f64_seq<S: Serializer>(values: &[f64], serializer: S) -> Result<S::Ok, S::Error> {
    let mut seq = serializer.serialize_seq(Some(values.len()))?;
    for v in values {
        seq.serialize_element(v)?;
    }
    seq.end()
}

/// Serialise a `BTreeMap<String, f64>` scope as a JSON object.
pub fn serialize_params<S: Serializer>(
    values: &BTreeMap<String, f64>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    let mut map = serializer.serialize_map(Some(values.len()))?;
    for (k, v) in values {
        map.serialize_entry(k, v)?;
    }
    map.end()
}
