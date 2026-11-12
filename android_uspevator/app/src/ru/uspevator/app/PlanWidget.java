package ru.uspevator.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.util.SizeF;
import android.util.TypedValue;
import android.view.View;
import android.widget.RemoteViews;
import android.widget.Toast;

import org.json.JSONException;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Date;
import java.util.Locale;
import java.util.LinkedHashMap;
import java.util.Map;

public final class PlanWidget extends AppWidgetProvider {
    static final String FORM = "form", TOKEN = "token";
    private static final String COMMAND = "ru.uspevator.app.WIDGET_COMMAND";
    private static final int FLAGS = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;
    private static final int WARNING = 0xffffde98, META = 0xffe2d7f6, INK = 0xff342158;
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static Runnable undoRefresh;

    static boolean isForm(String form) {
        return "add".equals(form) || "choose-template".equals(form) || "task-actions".equals(form) || "remaining".equals(form)
            || "new-plan".equals(form) || "repeat".equals(form) || "sound".equals(form);
    }

    static PendingIntent open(Context context, int id, String form, String token) {
        Intent intent = new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .setData(actionUri(id, form == null ? "open" : form, token));
        if (form != null) intent.putExtra(FORM, form).putExtra(TOKEN, token);
        return PendingIntent.getActivity(context, id, intent, FLAGS);
    }

    static PendingIntent control(Context context, int id, String action, String token) {
        Intent intent = new Intent(context, PlanWidget.class).setAction(COMMAND)
            .setData(actionUri(id, action, token)).putExtra("action", action).putExtra(TOKEN, token);
        return PendingIntent.getBroadcast(context, id, intent, FLAGS);
    }

    private static Uri actionUri(int id, String action, String token) {
        return new Uri.Builder().scheme("uspevator").authority("widget").appendPath(String.valueOf(id))
            .appendPath(action).appendPath(token == null ? "" : token).build();
    }

    static int[] ids(Context context) {
        return AppWidgetManager.getInstance(context).getAppWidgetIds(new ComponentName(context, PlanWidget.class));
    }

    static boolean updateAll(Context context) {
        int[] ids = ids(context);
        if (ids.length == 0) return false;
        render(context, ids);
        if (undoRefresh != null) MAIN.removeCallbacks(undoRefresh);
        if (PlanStore.canUndoFinish(PlanStore.read(context))) {
            Context app = context.getApplicationContext();
            undoRefresh = () -> render(app, ids(app));
            MAIN.postDelayed(undoRefresh, 8100);
        }
        return true;
    }

    @Override public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        render(context, ids);
        TimerService.reconcile(context, false);
    }

    @Override public void onAppWidgetOptionsChanged(Context context, AppWidgetManager manager, int id, Bundle options) {
        render(context, new int[]{id});
    }

    @Override public void onDisabled(Context context) {
        TimerService.reconcile(context, false);
    }

    @Override public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        if (PlanNotification.DISMISS.equals(intent.getAction())) {
            PlanStore.preferences(context).edit().putBoolean(PlanStore.SHADE_TIMER, false).apply();
            TimerService.reconcile(context, false);
            return;
        }
        if (!COMMAND.equals(intent.getAction())) return;
        String action = intent.getStringExtra("action");
        boolean saved = PlanStore.widgetAction(context, action, intent.getStringExtra(TOKEN));
        updateAll(context);
        TimerService.reconcile(context, saved);
        if (!saved) Toast.makeText(context, "План обновился. Повторите действие.", Toast.LENGTH_SHORT).show();
    }

    static PlanState.Snapshot snapshot(PlanState plan, long now) {
        try {
            if (plan != null) return plan.snapshot(now);
        } catch (JSONException error) {
            Log.w("UspevatorWidget", "Cannot render saved plan", error);
        }
        return new PlanState.Snapshot();
    }

    private static void render(Context context, int[] ids) {
        if (ids.length == 0) return;
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        PlanState plan = PlanStore.readPlan(context);
        long now = System.currentTimeMillis();
        PlanState.Snapshot view = snapshot(plan, now);
        String token = plan == null ? null : plan.token;
        boolean undo = PlanStore.canUndoFinish(PlanStore.read(context));
        Bitmap strip = view.hasPlan ? strip(view.riskPosition) : null;
        for (int id : ids) {
            Bundle options = manager.getAppWidgetOptions(id);
            if (Build.VERSION.SDK_INT >= 31) {
                ArrayList<SizeF> sizes = options.getParcelableArrayList(AppWidgetManager.OPTION_APPWIDGET_SIZES);
                if (sizes != null && !sizes.isEmpty() && sizes.size() <= 16) {
                    Map<SizeF, RemoteViews> layouts = new LinkedHashMap<>();
                    for (SizeF size : sizes) {
                        layouts.put(size, card(context, id, view, now, token, undo,
                            Math.round(size.getWidth()), Math.round(size.getHeight()), strip));
                    }
                    manager.updateAppWidget(id, new RemoteViews(layouts));
                    continue;
                }
            }
            int height = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 128);
            int width = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 244);
            manager.updateAppWidget(id, card(context, id, view, now, token, undo, width, height, strip));
        }
    }

    static RemoteViews shadeCard(Context context, int id, PlanState.Snapshot view, long now, String token) {
        int screenWidth = context.getResources().getConfiguration().screenWidthDp;
        return card(context, id, view, now, token, PlanStore.canUndoFinish(PlanStore.read(context)),
            Math.min(420, Math.max(220, screenWidth - 44)), 190, view.hasPlan ? strip(view.riskPosition) : null);
    }

    private static RemoteViews card(Context context, int id, PlanState.Snapshot view, long now, String token,
                                    boolean undo, int width, int height, Bitmap strip) {
        RemoteViews card = new RemoteViews(context.getPackageName(), R.layout.plan_widget);
        long realtime = SystemClock.elapsedRealtime();
        boolean running = PlanState.RUNNING.equals(view.phase);
        boolean paused = PlanState.PAUSED.equals(view.phase);
        boolean done = PlanState.DONE.equals(view.phase);
        boolean active = view.clock != null;
        boolean canDefer = active && view.total - view.completed > 1;
        boolean roomy = height >= 166;
        boolean tight = height < 126;
        boolean exhausted = active && view.clock.guarded <= 0;
        card.setOnClickPendingIntent(R.id.widget_root, open(context, id, null, null));
        card.setOnClickPendingIntent(R.id.widget_title_block, open(context, id, active ? "task-actions" : null, token));
        card.setTextViewText(R.id.widget_task, shortText(active ? view.task : done ? "План завершён"
            : view.hasPlan ? "Готово к старту" : "Пока нет задач"));
        card.setTextViewTextSize(R.id.widget_task, TypedValue.COMPLEX_UNIT_SP, roomy ? 19 : 17);
        card.setTextViewText(R.id.widget_status, active ? "Задача " + (view.completed + 1) + " из " + view.total
            + (paused ? " · На паузе" : "") : PlanState.IDLE.equals(view.phase) && view.hasPlan
                ? "План · расчёт " + time(now, now) : "План дня");
        show(card, R.id.widget_status, !paused || view.pauseMs < 0);
        show(card, R.id.widget_pause, paused && view.pauseMs >= 0);
        card.setChronometer(R.id.widget_pause, realtime - Math.max(0, view.pauseMs), "Пауза %s", paused && view.pauseMs >= 0);

        card.setImageViewResource(R.id.widget_sound, view.sound ? R.drawable.volume_on : R.drawable.volume_off);
        card.setContentDescription(R.id.widget_sound, view.sound ? "Выключить звук" : "Включить звук");
        card.setOnClickPendingIntent(R.id.widget_sound, token == null ? open(context, id, "sound", null)
            : control(context, id, "sound", token));
        show(card, R.id.widget_undo, undo);
        if (undo) card.setOnClickPendingIntent(R.id.widget_undo, control(context, id, "undo", token));

        show(card, R.id.widget_step, roomy && active && !view.step.isEmpty());
        card.setTextViewText(R.id.widget_step, "Первый шаг · " + shortText(view.step));
        show(card, R.id.widget_clocks, active);
        show(card, R.id.widget_fact, active || done);
        float widthInside = Math.max(190, width - 16);
        if (active) {
            float clockColumn = widthInside * 1.12f / 4.24f;
            int baseSize = clockSize(view.clock.optimistic, clockColumn, tight ? 16 : 22);
            int safeSize = clockSize(view.clock.guarded, clockColumn, tight ? 15 : 20);
            clock(card, R.id.base_static, R.id.base_live, view.clock.optimistic, realtime, running, true,
                null, baseSize, view.clock.optimistic <= 0 ? WARNING : Color.WHITE);
            clock(card, R.id.safe_static, R.id.safe_live, view.clock.guarded, realtime, running, true,
                null, safeSize, view.clock.guarded <= 0 ? WARNING : Color.WHITE);
            card.setTextViewText(R.id.base_label, view.clock.optimistic < 0 ? "Сверх оптим." : width < 320 ? "Оптим." : "Оптимистично");
            card.setTextViewText(R.id.safe_label, view.clock.guarded < 0 ? "Сверх оценки" : "С запасом");
        } else {
            card.setChronometer(R.id.base_live, realtime, null, false);
            card.setChronometer(R.id.safe_live, realtime, null, false);
        }
        clock(card, R.id.fact_static, R.id.fact_live, view.elapsed, realtime, running, false,
            width < 260 ? null : done ? "Время плана " : "Работа ", 11, META);
        show(card, R.id.widget_plan, view.hasPlan);
        show(card, R.id.widget_buffer, view.hasPlan);
        if (view.hasPlan) {
            boolean draft = PlanState.IDLE.equals(view.phase);
            boolean draftLength = draft && (!view.scheduled || view.promise == view.forecast);
            String promiseLabel = draft ? (view.scheduled ? "Финиш по плану" : "Финиш с запасом")
                : active ? "Обещано" : "Обещано к";
            float column = widthInside / (active ? 4.24f : 2);
            finishTime(card, R.id.promise_label, R.id.promise_time, promiseLabel, time(view.promise, now), column);
            String forecastLabel = exhausted ? "Остаток" : done ? "Завершено в"
                : draftLength ? "Длительность" : draft ? "Если начать сейчас" : "Прогноз";
            String forecast = exhausted ? "Уточнить" : draftLength ? PlanState.formatClock(view.baseline + view.buffer)
                : time(done ? view.finishedAt : view.forecast, now);
            finishTime(card, R.id.forecast_label, R.id.forecast_time, forecastLabel, forecast, column);
            card.setTextColor(R.id.forecast_time, exhausted || (!done && !draft && view.forecast - view.promise >= 60_000)
                ? WARNING : Color.WHITE);
            if (exhausted) card.setTextViewTextSize(R.id.forecast_time, TypedValue.COMPLEX_UNIT_SP, 11);
            card.setOnClickPendingIntent(R.id.forecast_block, open(context, id, exhausted ? "remaining" : null, token));
            card.setImageViewBitmap(R.id.widget_strip, strip);
            String risk = riskLabel(view.risk);
            card.setTextViewText(R.id.widget_risk, "Буфер · " + risk);
            card.setContentDescription(R.id.widget_strip, "Буфер плана · " + risk);
        }

        show(card, R.id.widget_next, (roomy && active && !view.next.isEmpty()) || (done && height >= 132));
        if (done) {
            long delta = view.finishedAt - view.promise;
            card.setTextViewText(R.id.widget_next, delta == 0 ? "Ровно к обещанному сроку"
                : (delta < 0 ? "Раньше на " : "Позже на ") + PlanState.formatClock(Math.abs(delta)));
        } else card.setTextViewText(R.id.widget_next, "Далее · " + shortText(view.next));

        if (active) {
            button(card, R.id.widget_primary, paused ? "Продолжить" : "Пауза",
                control(context, id, paused ? "start" : "pause", token), paused);
            button(card, R.id.widget_finish, "Готово", control(context, id, "finish", token), !paused);
        } else if (done) {
            button(card, R.id.widget_primary, "Новый список", open(context, id, "new-plan", token), true);
            button(card, R.id.widget_finish, "Повторить", open(context, id, "repeat", token), false);
        } else {
            button(card, R.id.widget_primary, view.hasPlan ? "Начать" : "Добавить задачу", view.hasPlan
                ? control(context, id, "start", token) : open(context, id, "add", token), true);
            if (!view.hasPlan) {
                button(card, R.id.widget_finish, "Выбрать шаблон", open(context, id, "choose-template", token), false);
            }
        }
        show(card, R.id.widget_finish, active || done || !view.hasPlan);
        show(card, R.id.widget_skip, canDefer);
        if (canDefer) {
            button(card, R.id.widget_skip, "Пропустить", control(context, id, "skip", token), false);
            card.setContentDescription(R.id.widget_skip, "Перенести текущую задачу в конец очереди");
        }
        float actionSize = canDefer && width < 255 ? 11 : 13;
        for (int button : new int[]{R.id.widget_primary, R.id.widget_finish, R.id.widget_skip}) {
            card.setTextViewTextSize(button, TypedValue.COMPLEX_UNIT_SP, actionSize);
            if (Build.VERSION.SDK_INT >= 31) card.setViewLayoutHeight(button, tight ? 32 : roomy ? 42 : 36,
                TypedValue.COMPLEX_UNIT_DIP);
        }
        show(card, R.id.widget_risk, !tight);
        if (Build.VERSION.SDK_INT >= 31) card.setViewLayoutHeight(R.id.widget_strip, tight ? 6 : 8, TypedValue.COMPLEX_UNIT_DIP);
        return card;
    }

    private static int clockSize(long value, float width, int preferred) {
        int digits = Math.max(5, PlanState.formatClock(value).length());
        return Math.max(11, Math.min(preferred, (int) ((width - 3) / (.63f * digits))));
    }

    private static void clock(RemoteViews views, int fixed, int live, long value, long realtime, boolean running,
                              boolean countdown, String prefix, int size, int color) {
        String text = PlanState.formatClock(value);
        views.setTextViewText(fixed, (prefix == null ? "" : prefix) + text);
        views.setChronometerCountDown(live, countdown);
        views.setChronometer(live, countdown ? realtime + value : realtime - value, prefix == null ? null : prefix + "%s", running);
        views.setTextViewTextSize(fixed, TypedValue.COMPLEX_UNIT_SP, size);
        views.setTextViewTextSize(live, TypedValue.COMPLEX_UNIT_SP, size);
        views.setTextColor(fixed, color);
        views.setTextColor(live, color);
        show(views, fixed, !running);
        show(views, live, running);
    }

    private static void button(RemoteViews card, int id, String label, PendingIntent action, boolean primary) {
        card.setTextViewText(id, label);
        card.setTextColor(id, primary ? INK : Color.WHITE);
        card.setInt(id, "setBackgroundResource", primary ? R.drawable.widget_primary : R.drawable.widget_secondary);
        card.setOnClickPendingIntent(id, action);
    }

    private static void finishTime(RemoteViews card, int captionId, int valueId, String caption, String label, float width) {
        String shown = label, heading = caption;
        if (label.length() >= 11 && label.charAt(5) == ' ' && width < 85) {
            shown = label.substring(0, 5);
            heading = (captionId == R.id.promise_label ? "К " : "На ") + label.substring(6, 11);
        }
        card.setTextViewText(captionId, heading);
        card.setTextViewText(valueId, shown);
        card.setContentDescription(valueId, caption + " " + label);
        float font = Math.max(10, Math.min(16, (width - 4) / (.63f * shown.length())));
        card.setTextViewTextSize(valueId, TypedValue.COMPLEX_UNIT_SP, font);
    }

    private static void show(RemoteViews card, int id, boolean show) {
        card.setViewVisibility(id, show ? View.VISIBLE : View.GONE);
    }

    static String shortText(String text) {
        return text.codePointCount(0, text.length()) <= 180 ? text
            : text.substring(0, text.offsetByCodePoints(0, 180)) + "…";
    }

    static String time(long value, long now) {
        if (!PlanState.validDate(value)) return "—";
        Calendar when = Calendar.getInstance();
        Calendar today = Calendar.getInstance();
        when.setTimeInMillis(value);
        today.setTimeInMillis(now);
        boolean sameYear = when.get(Calendar.YEAR) == today.get(Calendar.YEAR);
        String pattern = sameYear && when.get(Calendar.DAY_OF_YEAR) == today.get(Calendar.DAY_OF_YEAR) ? "HH:mm"
            : sameYear ? "HH:mm dd.MM" : "HH:mm dd.MM.yy";
        return new SimpleDateFormat(pattern, Locale.ROOT).format(new Date(value));
    }

    private static String riskLabel(String risk) {
        switch (risk) {
            case "green": return "В норме";
            case "yellow": return "Внимание";
            case "red": return "Под угрозой";
            case "over": return "Исчерпан";
            default: return "Без запаса";
        }
    }

    private static Bitmap strip(double position) {
        Bitmap image = Bitmap.createBitmap(360, 28, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(image);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        int[] colors = {0xff80cfab, 0xffffd27c, 0xfff697a3};
        float left = 10, width = 340;
        for (int i = 0; i < colors.length; i++) {
            paint.setColor(colors[i]);
            canvas.drawRect(left + i * width / 3, 10, left + (i + 1) * width / 3, 18, paint);
        }
        float marker = left + (float) position / 100 * width;
        paint.setColor(Color.WHITE);
        canvas.drawCircle(marker, 14, 9, paint);
        paint.setColor(0xff30214d);
        canvas.drawCircle(marker, 14, 6, paint);
        return image;
    }
}
