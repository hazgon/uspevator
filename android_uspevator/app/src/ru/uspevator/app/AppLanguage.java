package ru.uspevator.app;

import android.content.Context;
import android.content.res.Configuration;
import android.content.res.Resources;
import android.os.LocaleList;

import java.util.Locale;

final class AppLanguage {
    private AppLanguage() {}

    static String systemLanguage() {
        LocaleList locales = Resources.getSystem().getConfiguration().getLocales();
        return locales.isEmpty() ? "en" : locales.get(0).getLanguage();
    }

    static Context forPlan(Context context, PlanState plan) {
        String choice = plan == null ? "system" : plan.language();
        String language = "ru".equals(choice) || (!"en".equals(choice) && "ru".equals(systemLanguage())) ? "ru" : "en";
        Configuration config = new Configuration(context.getResources().getConfiguration());
        config.setLocale(Locale.forLanguageTag(language));
        return context.createConfigurationContext(config);
    }

    static String text(Context context, int id) {
        return forPlan(context, PlanStore.readPlan(context)).getString(id);
    }
}
