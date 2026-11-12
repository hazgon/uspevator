# Сборка из исходников

## HTML

Собери HTML из корня репозитория. Готовый `uspevator.html` появится там же.

```sh
python3 build_uspevator/build.py
node build_uspevator/test-run.js
```

Вторая команда запускает проверки логики и требует Node.js.

## Android

Понадобятся Bash, Python 3, Node.js, JDK, Android SDK Platform 35 и Build Tools 35.0.0. Задай путь к Android SDK через `ANDROID_HOME` или `ANDROID_SDK_ROOT`.

Помести [ECJ 3.39.0](https://repo.maven.apache.org/maven2/org/eclipse/jdt/ecj/3.39.0/ecj-3.39.0.jar) в `android_uspevator/tooling/ecj.jar`. Из [пакета TypeScript 5.7.3](https://registry.npmjs.org/typescript/-/typescript-5.7.3.tgz) возьми `lib/typescript.js` и положи его в `android_uspevator/tooling/typescript/lib/typescript.js`.

```sh
bash android_uspevator/build.sh
```

Команда соберёт неподписанный `android_uspevator/out/aligned.apk`. Для установки подпиши его своим ключом с помощью `apksigner`.
