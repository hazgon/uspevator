package ru.uspevator.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.SystemClock;
import android.util.Log;

import org.json.JSONException;

import java.util.Objects;

final class PlanStore {
    static final String PLAN_KEY = "plan", KEEP_SCREEN = "keep_screen", SIGNAL_VOLUME = "signal_volume";
    static final String THEME = "theme", SHADE_TIMER = "shade_timer";
    static final int MAX_JSON_BYTES = 8 * 1024 * 1024;
    static final int DEFAULT_VOLUME = 35;
    private static String cachedRaw;
    private static PlanState cachedPlan;
    private static String undoBefore, undoExpected;
    private static long undoUntil, finishAfter;

    private PlanStore() {}

    static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences("uspevator", Context.MODE_PRIVATE);
    }

    static String read(Context context) {
        return preferences(context).getString(PLAN_KEY, null);
    }

    static synchronized PlanState readPlan(Context context) {
        String raw = read(context);
        if (Objects.equals(raw, cachedRaw)) return cachedPlan;
        cachedRaw = raw;
        try {
            cachedPlan = PlanState.parse(raw);
        } catch (JSONException error) {
            cachedPlan = null;
            Log.w("Uspevator", "Saved plan cannot be read", error);
        }
        return cachedPlan;
    }

    static synchronized String compareAndSet(Context context, String expected, String next, boolean finish) {
        if (next == null || next.isEmpty() || next.length() > MAX_JSON_BYTES) return "error";
        SharedPreferences prefs = preferences(context);
        String current = prefs.getString(PLAN_KEY, null);
        if (!Objects.equals(expected, current) || (finish && SystemClock.elapsedRealtime() < finishAfter)) return "conflict";
        try {
            PlanState.parse(next);
            return save(prefs, current, next, finish) ? "ok" : "error";
        } catch (JSONException error) {
            Log.w("Uspevator", "Rejected invalid plan", error);
            return "error";
        }
    }

    static synchronized boolean widgetAction(Context context, String action, String token) {
        SharedPreferences prefs = preferences(context);
        String raw = prefs.getString(PLAN_KEY, null);
        try {
            PlanState state = PlanState.parse(raw);
            if (state == null || !state.token.equals(token)) return false;
            if ("undo".equals(action)) return undoFinish(context, raw);
            boolean finish = "finish".equals(action);
            if (finish && SystemClock.elapsedRealtime() < finishAfter) return false;
            return state.apply(action, System.currentTimeMillis()) && save(prefs, raw, state.serialize(), finish);
        } catch (JSONException | ArithmeticException error) {
            Log.w("Uspevator", "Widget action failed", error);
            return false;
        }
    }

    static synchronized boolean canUndoFinish(String expected) {
        if (undoBefore != null && SystemClock.elapsedRealtime() >= undoUntil) clearUndo();
        return undoBefore != null && Objects.equals(undoExpected, expected);
    }

    static synchronized boolean undoFinish(Context context, String expected) {
        if (!canUndoFinish(expected) || !Objects.equals(read(context), expected)) return false;
        return save(preferences(context), expected, undoBefore, false);
    }

    private static void clearUndo() {
        undoBefore = null;
        undoExpected = null;
        undoUntil = 0;
    }

    private static boolean save(SharedPreferences prefs, String before, String next, boolean finish) {
        if (!prefs.edit().putString(PLAN_KEY, next).commit()) {
            prefs.edit().putString(PLAN_KEY, before).commit();
            Log.e("Uspevator", "Could not save plan");
            return false;
        }
        clearUndo();
        if (finish) {
            long now = SystemClock.elapsedRealtime();
            undoBefore = before;
            undoExpected = next;
            undoUntil = now + 8000;
            finishAfter = now + 400;
        }
        return true;
    }
}
