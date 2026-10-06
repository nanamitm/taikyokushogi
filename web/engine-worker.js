// Web Worker port of the HTTP API in web_gui.py, backed by the Rust engine
// compiled to WebAssembly. Keep the response shapes in sync with web_gui.py.
import init, {WasmBoard, piece_info_json} from './pkg/taikyokushogi.js';

const BLACK = 0;
const ready = init();

function pad2(n) { return String(n).padStart(2, '0'); }
function nowString() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
           `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function sq(r, c) { return `(${r},${c})`; }

class GameState {
    constructor() { this.reset(); }

    reset(mode = 'human_vs_random', humanColor = BLACK) {
        if (this.board) this.board.free();
        this.board = new WasmBoard();
        this.mode = mode;
        this.human_color = humanColor;
        this.move_log = [];
        this.score_history = [this.board.score()];
        this.half_move = 0;
        this.game_over = false;
        this.record = [];
        this.last_move_time = performance.now();
        this.game_start_time = nowString();
    }

    recordMove(side, piece, fr, fc, tr, tc, promo, score) {
        const now = performance.now();
        const elapsed = Math.round((now - this.last_move_time) / 10) / 100;
        this.last_move_time = now;
        this.record.push({n: this.half_move, side, piece, from: [fr, fc], to: [tr, tc],
                          promo, time: elapsed, score});
    }

    boardJson() {
        const b = this.board;
        return {
            board: JSON.parse(b.board_json()),
            side_to_move: b.side_to_move,
            move_number: b.move_number,
            game_result: b.game_result() ?? null,
            black_pieces: b.black_piece_count(),
            white_pieces: b.white_piece_count(),
        };
    }

    // Shared tail of /api/move and /api/ai-move
    finishMove(side, pname, fr, fc, tr, tc, promotion, suffix = '') {
        const score = this.board.score();
        this.score_history.push(score);
        this.recordMove(side, pname, fr, fc, tr, tc, promotion, score);
        const promoS = promotion ? '+' : '';
        this.move_log.push(`${this.half_move}. ${side}: ${pname} ${sq(fr, fc)}-${sq(tr, tc)}${promoS}${suffix}`);
        const data = this.boardJson();
        if (data.game_result) {
            this.game_over = true;
            this.move_log.push(`** Game over: ${data.game_result} **`);
        }
        return {
            ok: true, ...data,
            move_log: this.move_log.slice(-50),
            move_log_offset: Math.max(0, this.move_log.length - 50),
            score_history: this.score_history,
            game_over: this.game_over,
        };
    }

    buildRecord() {
        const lines = [
            '# Taikyoku Shogi Game Record',
            `# Date: ${this.game_start_time}`,
            `# Mode: ${this.mode}`,
            `# Result: ${this.board.game_result() || 'in progress'}`,
            `# Moves: ${this.half_move}`,
            `# Final score (Black perspective): ${this.board.score()}`,
            '#',
            '# move\tside\tpiece\tfrom_r\tfrom_c\tto_r\tto_c\tpromo\ttime_s\tscore',
        ];
        for (const r of this.record) {
            lines.push([r.n, r.side, r.piece, r.from[0], r.from[1], r.to[0], r.to[1],
                        r.promo ? '+' : '', r.time, r.score].join('\t'));
        }
        lines.push('');
        return lines.join('\n');
    }
}

let game = null;

function handle({method, path, query, body}) {
    const b = game.board;

    if (method === 'GET' && path === '/api/state') {
        return {
            ...game.boardJson(),
            mode: game.mode,
            human_color: game.human_color,
            move_count: game.move_log.length,
            move_log: game.move_log.slice(-50),
            move_log_offset: Math.max(0, game.move_log.length - 50),
            score_history: game.score_history,
            game_over: game.game_over,
        };
    }
    if (method === 'GET' && path === '/api/moves') {
        const r = parseInt(query.r ?? '-1'), c = parseInt(query.c ?? '-1');
        if (r < 0 || c < 0) return {moves: [], from: [r, c]};
        return {moves: JSON.parse(b.moves_from_json(r, c)), from: [r, c]};
    }
    if (method === 'GET' && path === '/api/piece-info') {
        return JSON.parse(piece_info_json(query.abbrev ?? ''));
    }
    if (method === 'GET' && path === '/api/record') {
        return {text: game.buildRecord()};
    }
    if (method === 'POST' && path === '/api/new-game') {
        game.reset(body.mode ?? 'human_vs_random', body.human_color ?? BLACK);
        return {ok: true};
    }
    if (method === 'POST' && path === '/api/move') {
        if (game.game_over) return {ok: false, error: 'Game is over'};
        const [fr, fc] = body.from, [tr, tc] = body.to;
        const promotion = !!body.promotion;
        const side = b.side_to_move === BLACK ? 'Black' : 'White';
        const pname = b.piece_at(fr, fc) ?? '?';
        if (!b.apply_move(fr, fc, tr, tc, promotion)) return {ok: false, error: 'Illegal move'};
        game.half_move += 1;
        return game.finishMove(side, pname, fr, fc, tr, tc, promotion);
    }
    if (method === 'POST' && path === '/api/ai-move') {
        if (game.game_over) return {ok: false, error: 'Game is over'};
        const depth = body.depth ?? 0;
        const timeLimit = body.time_limit ?? 30000;
        const side = b.side_to_move === BLACK ? 'Black' : 'White';
        let mv, searchMs = 0;
        if (depth === 0) {
            mv = JSON.parse(b.random_move_json());
        } else {
            const res = JSON.parse(b.search_json(depth, timeLimit));
            mv = res.move;
            searchMs = res.time_ms;
        }
        if (!mv) {
            game.game_over = true;
            game.move_log.push('No legal moves - stalemate');
            return {ok: false, error: 'No legal moves'};
        }
        const [fr, fc, tr, tc, promotion] = mv;
        const pname = b.piece_at(fr, fc) ?? '?';
        b.apply_move(fr, fc, tr, tc, promotion);
        game.half_move += 1;
        const depthS = depth > 0 ? ` d${depth}` : '';
        const timeS = searchMs ? ` ${searchMs}ms` : '';
        const data = game.finishMove(side, pname, fr, fc, tr, tc, promotion, depthS + timeS);
        data.last_move = {from: [fr, fc], to: [tr, tc]};
        return data;
    }
    if (method === 'POST' && path === '/api/undo') {
        if (!b.undo()) return {ok: false, error: 'Nothing to undo'};
        game.move_log.pop();
        if (game.score_history.length > 1) game.score_history.pop();
        if (game.half_move > 0) game.half_move -= 1;
        game.game_over = false;
        return {ok: true};
    }
    return null;
}

self.onmessage = async (e) => {
    await ready;
    if (!game) game = new GameState();
    const {id, path} = e.data;
    let reply;
    try {
        const result = handle(e.data);
        if (result === null) {
            reply = {id, status: 404, body: 'Not found', contentType: 'text/plain'};
        } else if (path === '/api/record') {
            reply = {id, status: 200, body: result.text, contentType: 'text/plain; charset=utf-8'};
        } else {
            reply = {id, status: 200, body: JSON.stringify(result), contentType: 'application/json'};
        }
    } catch (err) {
        reply = {id, status: 500, body: JSON.stringify({ok: false, error: String(err)}),
                 contentType: 'application/json'};
    }
    self.postMessage(reply);
};
