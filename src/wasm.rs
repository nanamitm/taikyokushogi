//! WebAssembly bindings via wasm-bindgen (enabled with the `wasm` feature).
//!
//! Mirrors the PyO3 bindings in `python.rs`. Structured results are returned
//! as JSON strings so the JS side can simply `JSON.parse` them.

use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

use crate::types::*;
use crate::{board, pieces, movegen, eval, search};

fn rc(sq: u16) -> [usize; 2] {
    [sq as usize / BOARD_SIZE, sq as usize % BOARD_SIZE]
}

fn move_tuple(m: &Move) -> Value {
    let (f, t) = (rc(m.from_sq), rc(m.to_sq));
    json!([f[0], f[1], t[0], t[1], m.promotion])
}

#[wasm_bindgen]
pub struct WasmBoard {
    inner: board::Board,
}

#[wasm_bindgen]
impl WasmBoard {
    #[wasm_bindgen(constructor)]
    pub fn new() -> WasmBoard {
        let mut inner = board::Board::new();
        inner.setup_initial();
        WasmBoard { inner }
    }

    /// Piece abbreviation at (row, col), or `undefined` if empty.
    pub fn piece_at(&self, row: usize, col: usize) -> Option<String> {
        let cell = self.inner.cells[sq_index(row, col)];
        if cell == EMPTY_CELL { None } else { Some(pieces::abbrev(cell_piece(cell)).to_string()) }
    }

    /// Whole board as JSON: 36x36 array of `null` or `{piece, color, name}`.
    pub fn board_json(&self) -> String {
        let mut rows = Vec::with_capacity(BOARD_SIZE);
        for r in 0..BOARD_SIZE {
            let mut row = Vec::with_capacity(BOARD_SIZE);
            for c in 0..BOARD_SIZE {
                let cell = self.inner.cells[sq_index(r, c)];
                if cell == EMPTY_CELL {
                    row.push(Value::Null);
                } else {
                    let pt = cell_piece(cell);
                    row.push(json!({
                        "piece": pieces::abbrev(pt),
                        "color": cell_color(cell),
                        "name": pieces::name(pt),
                    }));
                }
            }
            rows.push(Value::Array(row));
        }
        Value::Array(rows).to_string()
    }

    #[wasm_bindgen(getter)]
    pub fn side_to_move(&self) -> u8 { self.inner.side_to_move }

    #[wasm_bindgen(getter)]
    pub fn move_number(&self) -> u32 { self.inner.move_number }

    pub fn black_piece_count(&self) -> usize { self.inner.piece_count[BLACK as usize] }
    pub fn white_piece_count(&self) -> usize { self.inner.piece_count[WHITE as usize] }

    pub fn game_result(&self) -> Option<String> {
        self.inner.game_result().map(|r| match r {
            GameResult::BlackWins => "black_wins".into(),
            GameResult::WhiteWins => "white_wins".into(),
            GameResult::Draw => "draw".into(),
        })
    }

    pub fn score(&self) -> i32 { eval::material_score(&self.inner) }

    pub fn apply_move(&mut self, from_r: usize, from_c: usize,
                      to_r: usize, to_c: usize, promotion: bool) -> bool {
        let from_sq = sq_index(from_r, from_c) as u16;
        let to_sq = sq_index(to_r, to_c) as u16;
        for m in &movegen::generate_legal_moves(&self.inner) {
            if m.from_sq == from_sq && m.to_sq == to_sq && m.promotion == promotion {
                self.inner.apply_move(m);
                return true;
            }
        }
        false
    }

    pub fn undo(&mut self) -> bool { self.inner.undo_move() }

    /// Legal moves from (r, c) as JSON: `[{to, promotion, is_igui, captured}]`.
    pub fn moves_from_json(&self, r: usize, c: usize) -> String {
        let sq = sq_index(r, c) as u16;
        let mut seen = std::collections::HashSet::new();
        let mut list = Vec::new();
        for m in &movegen::generate_legal_moves(&self.inner) {
            if m.from_sq == sq && seen.insert((m.to_sq, m.promotion, m.is_igui)) {
                list.push(json!({
                    "to": rc(m.to_sq),
                    "promotion": m.promotion,
                    "is_igui": m.is_igui,
                    "captured": if m.captured_piece != 0 { Some(pieces::name(m.captured_piece)) } else { None },
                }));
            }
        }
        Value::Array(list).to_string()
    }

    /// Random legal move as JSON `[fr, fc, tr, tc, promotion]`, or `null`.
    pub fn random_move_json(&self) -> String {
        let moves = movegen::generate_legal_moves(&self.inner);
        if moves.is_empty() { return "null".into(); }
        use rand::Rng;
        let idx = rand::thread_rng().gen_range(0..moves.len());
        move_tuple(&moves[idx]).to_string()
    }

    /// Search as JSON `{move: [fr, fc, tr, tc, promotion] | null, score, nodes, time_ms}`.
    pub fn search_json(&mut self, depth: u32, time_limit_ms: u32) -> String {
        let result = search::search(&mut self.inner, depth, time_limit_ms as u64);
        json!({
            "move": result.best_move.as_ref().map(move_tuple),
            "score": result.score,
            "nodes": result.nodes,
            "time_ms": result.time_ms,
        }).to_string()
    }
}

/// Piece details as JSON (same shape as `piece_info_py`).
#[wasm_bindgen]
pub fn piece_info_json(abbrev: &str) -> String {
    match pieces::find_by_abbrev(abbrev) {
        Some(pt) => {
            let mv = pieces::movement(pt);
            let mut sp: Vec<&str> = Vec::new();
            if mv.hook.is_some() { sp.push("hook"); }
            if mv.area > 0 { sp.push("area"); }
            if !mv.range_capture.is_empty() { sp.push("range capture"); }
            if mv.igui { sp.push("igui"); }
            json!({
                "abbrev": abbrev,
                "name": pieces::name(pt),
                "value": pieces::value(pt),
                "promotes_to": pieces::promotes_to(pt).map(pieces::name),
                "slide_directions": mv.slides.len(),
                "jump_destinations": mv.jumps.len(),
                "specials": sp,
            })
        }
        None => json!({
            "abbrev": abbrev, "name": abbrev, "value": 0, "promotes_to": null,
            "slide_directions": 0, "jump_destinations": 0, "specials": [],
        }),
    }.to_string()
}
