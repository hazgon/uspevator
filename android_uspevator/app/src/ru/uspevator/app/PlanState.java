package ru.uspevator.app;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Locale;

/** Native clock and transitions shared by the widget and background signal. */
final class PlanState {
    static final String IDLE = "idle", RUNNING = "running", PAUSED = "paused", DONE = "done";
    private static final long MAX_DATE = 8_640_000_000_000_000L;
    private static final int HISTORY_LIMIT = 180;
    private final JSONObject json, timer, window, settings;
    private final JSONArray tasks;
    final String token;

    static PlanState parse(String raw) throws JSONException {
        return raw == null || raw.isEmpty() ? null : new PlanState(raw);
    }

    private PlanState(String raw) throws JSONException {
        json = new JSONObject(raw);
        if (json.getInt("version") != 1) throw new JSONException("Unsupported plan version");
        tasks = json.getJSONArray("tasks");
        timer = json.getJSONObject("timer");
        window = json.getJSONObject("window");
        settings = json.getJSONObject("settings");
        token = fingerprint(raw);
        String phase = phase();
        if (!IDLE.equals(phase) && !RUNNING.equals(phase) && !PAUSED.equals(phase) && !DONE.equals(phase)) {
            throw new JSONException("Unknown timer phase");
        }
        if (!IDLE.equals(phase)) {
            JSONObject first = firstOpen();
            long start = timer.getLong("startedAt");
            if (!validDate(start) || tasks.length() == 0 ||
                    (DONE.equals(phase) ? first != null || !validDate(timer.getLong("finishedAt"))
                            : first == null || !first.getString("id").equals(timer.optString("activeId")))) {
                throw new JSONException("Timer and queue disagree");
            }
            if (RUNNING.equals(phase) && timer.getLong("runningSince") < start) throw new JSONException("Invalid start");
        }
    }

    private static String fingerprint(String text) {
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
            char[] hex = "0123456789abcdef".toCharArray();
            char[] result = new char[bytes.length * 2];
            for (int i = 0; i < bytes.length; i++) {
                int value = bytes[i] & 255;
                result[2 * i] = hex[value >>> 4];
                result[2 * i + 1] = hex[value & 15];
            }
            return new String(result);
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    static boolean validDate(long time) {
        return time >= 0 && time <= MAX_DATE;
    }

    String phase() { return timer.optString("phase"); }
    boolean running() { return RUNNING.equals(phase()); }
    boolean active() { return running() || PAUSED.equals(phase()); }
    boolean sound() { return settings.optBoolean("sound", true); }
    String language() { return settings.optString("language", "system"); }
    String serialize() { return json.toString(); }

    private int firstOpenIndex(int from) throws JSONException {
        for (int i = from; i < tasks.length(); i++) {
            if (!tasks.getJSONObject(i).getBoolean("done")) return i;
        }
        return -1;
    }

    private JSONObject firstOpen() throws JSONException {
        int index = firstOpenIndex(0);
        return index < 0 ? null : tasks.getJSONObject(index);
    }

    private JSONObject currentTask() throws JSONException {
        return active() ? firstOpen() : null;
    }

    private static long minutes(JSONObject task, String key) throws JSONException {
        double value = task.getDouble(key) * 60_000;
        if (!Double.isFinite(value) || value < 0 || value > 9_007_199_254_740_991d) {
            throw new JSONException("Invalid estimate");
        }
        return Math.round(value);
    }

    private long worked(JSONObject task, boolean current, long now) throws JSONException {
        long since = current && running() ? Math.max(0, now - timer.getLong("runningSince")) : 0;
        return Math.max(task.getLong("referenceMs"), task.getLong("workedMs") + since);
    }

    private Clock clock(JSONObject task, boolean current, long now) throws JSONException {
        long base = minutes(task, "minTime");
        long reserve = minutes(task, "maxTime") - base;
        long reference = task.getLong("referenceMs");
        long elapsed = worked(task, current, now);
        long left = task.isNull("remainingMs") ? base : task.getLong("remainingMs");
        long optimistic = left - (current ? Math.max(0, elapsed - reference) : 0);
        String key = current ? new JSONArray().put(timer.getLong("startedAt")).put(task.getString("id"))
            .put(reference).put(task.opt("remainingMs")).toString() : null;
        return new Clock(elapsed, optimistic, optimistic + reserve, reserve, key);
    }

    Clock currentClock(long now) throws JSONException {
        JSONObject current = currentTask();
        return current == null ? null : clock(current, true, now);
    }

    static final class Clock {
        final long elapsed, optimistic, guarded, reserve;
        final String key;
        Clock(long elapsed, long optimistic, long guarded, long reserve, String key) {
            this.elapsed = elapsed;
            this.optimistic = optimistic;
            this.guarded = guarded;
            this.reserve = reserve;
            this.key = key;
        }
    }

    static final class Snapshot {
        String phase = IDLE, task = "", step = "", next = "", risk = "neutral";
        boolean sound = true, hasPlan, scheduled;
        int completed, total;
        long pauseMs = -1, promise = -1, forecast = -1, earliest = -1, finishedAt = -1;
        long spent, baseline, buffer, elapsed, pausedSince = -1;
        double progress, penetration = Double.NaN, riskPosition;
        Clock clock;
    }

    Snapshot snapshot(long now) throws JSONException {
        Snapshot view = new Snapshot();
        view.phase = phase();
        view.sound = sound();
        boolean draft = IDLE.equals(view.phase);
        boolean done = DONE.equals(view.phase);
        view.hasPlan = tasks.length() > 0 || !draft;
        if (!view.hasPlan) return view;
        JSONObject current = currentTask();
        long nominal = 0, reserve = 0, workLeft = 0, guardedLeft = 0, earned = 0;
        for (int i = 0; i < tasks.length(); i++) {
            JSONObject task = tasks.getJSONObject(i);
            if (task.optBoolean("excluded")) continue;
            view.total++;
            long base = minutes(task, "minTime");
            nominal += base;
            reserve += minutes(task, "maxTime") - base;
            if (task.getBoolean("done")) {
                view.completed++;
                earned += base;
                continue;
            }
            boolean isCurrent = current != null && current.getString("id").equals(task.getString("id"));
            Clock timing = clock(task, isCurrent, now);
            workLeft += Math.max(0, timing.optimistic);
            guardedLeft += Math.max(0, timing.guarded);
            if (!task.isNull("remainingMs")) earned += Math.max(0, base - task.getLong("remainingMs"));
            if (isCurrent) {
                view.task = task.getString("name");
                view.step = task.optString("firstStep", "");
                view.clock = timing;
                view.elapsed = timing.elapsed;
            } else if (view.next.isEmpty()) {
                view.next = task.getString("name");
            }
        }
        view.baseline = draft ? nominal : timer.getLong("baselineMs");
        view.buffer = draft ? reserve : timer.getLong("bufferMs");
        view.scheduled = draft && !window.isNull("start");
        long anchor = draft ? (view.scheduled ? window.getLong("start") : now) : timer.getLong("startedAt");
        long at = done ? timer.getLong("finishedAt") : Math.max(now, anchor);
        view.promise = anchor + view.baseline + view.buffer;
        view.forecast = draft ? now + view.baseline + view.buffer : at + guardedLeft;
        view.earliest = at + workLeft;
        view.finishedAt = done ? at : -1;
        if (done) view.elapsed = at - anchor;
        if (PAUSED.equals(view.phase) && !timer.isNull("pausedSince")) {
            view.pausedSince = timer.getLong("pausedSince");
            view.pauseMs = Math.max(0, now - view.pausedSince);
        }
        double progress = nominal > 0 ? 100.0 * earned / nominal
            : view.total > 0 ? 100.0 * view.completed / view.total : 0;
        view.progress = done ? 100 : clamp(progress, 0, view.completed == view.total ? 100 : 99.9);
        view.spent = at - anchor + workLeft - view.baseline;
        if (view.buffer > 0) view.penetration = 100.0 * view.spent / view.buffer;
        setRisk(view);
        return view;
    }

    private static double clamp(double value, double min, double max) {
        return Math.max(min, Math.min(max, value));
    }

    private static void setRisk(Snapshot view) {
        if (Double.isNaN(view.penetration)) {
            view.risk = view.spent > 0 ? "over" : "neutral";
            view.riskPosition = view.spent > 0 ? 100 : 0;
            return;
        }
        double used = view.penetration;
        double yellow = 5 + 0.4 * view.progress;
        double red = yellow + 50;
        view.risk = used > 100 ? "over" : used >= red ? "red" : used >= yellow ? "yellow" : "green";
        double scale = used < yellow ? used / yellow
            : used < red ? 1 + (used - yellow) / 50 : 2 + (used - red) / (100 - red);
        view.riskPosition = 100 * clamp(scale, 0, 3) / 3;
    }

    private void recordPoint(long now) throws JSONException {
        Snapshot view = snapshot(now);
        if (IDLE.equals(view.phase) || Double.isNaN(view.penetration)) return;
        JSONArray points = timer.getJSONArray("points");
        int count = points.length();
        if (count > 0) {
            JSONObject last = points.getJSONObject(count - 1);
            if (Math.abs(last.getDouble("x") - view.progress) < .005
                    && Math.abs(last.getDouble("y") - view.penetration) < .005) return;
        }
        if (count >= HISTORY_LIMIT) points.remove(1);
        points.put(new JSONObject().put("x", view.progress).put("y", view.penetration).put("at", now));
    }

    boolean apply(String action, long now) throws JSONException {
        switch (action) {
            case "start": return start(now);
            case "pause": return pause(now);
            case "finish": return advance(now, false);
            case "skip": return advance(now, true);
            case "sound": settings.put("sound", !sound()); return true;
            default: return false;
        }
    }

    private boolean start(long now) throws JSONException {
        if (PAUSED.equals(phase())) {
            recordPoint(now);
            timer.put("phase", RUNNING).put("runningSince", Math.max(timer.getLong("startedAt"), now))
                .put("pausedSince", JSONObject.NULL);
            return true;
        }
        if (!IDLE.equals(phase()) || tasks.length() == 0) return false;
        long anchor = Math.min(now, window.isNull("start") ? now : window.getLong("start"));
        Snapshot draft = snapshot(now);
        JSONArray points = new JSONArray();
        if (draft.buffer > 0) points.put(new JSONObject().put("x", 0).put("y", 0).put("at", anchor));
        timer.put("phase", RUNNING).put("startedAt", anchor).put("runningSince", now)
            .put("pausedSince", JSONObject.NULL).put("finishedAt", JSONObject.NULL)
            .put("activeId", tasks.getJSONObject(0).getString("id")).put("baselineMs", draft.baseline)
            .put("bufferMs", draft.buffer).put("points", points);
        recordPoint(now);
        return true;
    }

    private boolean pause(long now) throws JSONException {
        if (!running()) return false;
        JSONObject task = currentTask();
        if (task == null) return false;
        recordPoint(now);
        task.put("workedMs", worked(task, true, now));
        long stopped = Math.max(now, timer.getLong("runningSince"));
        timer.put("phase", PAUSED).put("runningSince", JSONObject.NULL).put("pausedSince", stopped);
        return true;
    }

    private boolean advance(long now, boolean defer) throws JSONException {
        if (!active()) return false;
        int index = firstOpenIndex(0);
        if (index < 0 || (defer && firstOpenIndex(index + 1) < 0)) return false;
        JSONObject task = tasks.getJSONObject(index);
        recordPoint(now);
        long elapsed = worked(task, true, now);
        task.put("workedMs", elapsed);
        if (defer) {
            task.put("referenceMs", elapsed);
            tasks.remove(index);
            tasks.put(task);
        } else task.put("done", true);
        JSONObject next = firstOpen();
        long time = Math.max(timer.getLong("startedAt"), now);
        timer.put("activeId", next == null ? JSONObject.NULL : next.getString("id"));
        if (next == null) {
            timer.put("phase", DONE).put("runningSince", JSONObject.NULL)
                .put("pausedSince", JSONObject.NULL).put("finishedAt", time);
        } else if (running()) timer.put("runningSince", time);
        recordPoint(now);
        return true;
    }

    static String formatClock(long ms) {
        long seconds = Math.abs(ms / 1000);
        String sign = ms <= -1000 ? "−" : "";
        return sign + (seconds >= 3600
            ? String.format(Locale.ROOT, "%02d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60)
            : String.format(Locale.ROOT, "%02d:%02d", seconds / 60, seconds % 60));
    }
}
