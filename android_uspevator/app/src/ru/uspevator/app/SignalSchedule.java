package ru.uspevator.app;

/** Schedules the next change in a task's own countdown on a monotonic clock. */
final class SignalSchedule {
    enum Pattern { SILENCE, WARNING, PULSE, CONTINUOUS, KEEP }
    static final int PULSE_MS = 100;
    static final int WARNING_MS = 270;
    static final long RECHECK_MS = 30_000;
    private String key;
    private boolean armed, warned;
    private long warningUntil, nextPulse;

    static final class Event {
        final Pattern pattern;
        final long delay;
        Event(Pattern pattern, long delay) {
            this.pattern = pattern;
            this.delay = Math.max(1, Math.min(RECHECK_MS, delay));
        }
    }

    void suspend() {
        warningUntil = 0;
        nextPulse = 0;
    }

    Event next(PlanState.Clock clock, long now) {
        if (!clock.key.equals(key)) {
            key = clock.key;
            armed = false;
            warned = false;
            suspend();
        }
        if (clock.optimistic > 0) {
            armed = true;
            warned = false;
            suspend();
            return new Event(Pattern.SILENCE, clock.optimistic);
        }
        if (!warned) {
            warned = true;
            if (armed || clock.optimistic >= -500) {
                warningUntil = now + WARNING_MS;
                return new Event(Pattern.WARNING, WARNING_MS);
            }
        }
        if (now < warningUntil) return new Event(Pattern.KEEP, warningUntil - now);
        if (clock.guarded <= 0) return new Event(Pattern.CONTINUOUS, RECHECK_MS);
        if (now < nextPulse) return new Event(Pattern.KEEP, Math.min(clock.guarded, nextPulse - now));
        double remainingFraction = clock.reserve > 0 ? (double) clock.guarded / clock.reserve : 0;
        long interval = PULSE_MS + Math.round(2900 * Math.min(1, Math.max(0, remainingFraction)));
        nextPulse = now + interval;
        return new Event(Pattern.PULSE, Math.min(clock.guarded, interval));
    }
}
