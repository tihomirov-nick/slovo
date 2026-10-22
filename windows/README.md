# Slovo для Windows

Та же расшифровка, что и в Slovo для Mac, в одном файле `Slovo.exe`. Окно открывается в Microsoft Edge в режиме
приложения, без вкладок и адресной строки. ffmpeg и whisper.cpp вложены в exe и при первом запуске распаковываются
в `%LOCALAPPDATA%\Slovo`, модели скачиваются туда же. Файл можно перетащить в окно или на значок `Slovo.exe`.

По сравнению с Mac нет автообновлений, значка в трее, запуска при входе и меню «Поделиться», а Whisper считает
на процессоре.

## Сборка

`./windows/build.sh` собирает `windows/dist/Slovo.exe` на Mac или на Windows (Git Bash), нужен Go. Visual C++ runtime,
без которого whisper.cpp не запускается на чистой Windows, добавляется только при сборке на Windows. Поэтому готовый exe
собирает GitHub Actions (`.github/workflows/windows.yml`, ветка `windows`): он же проверяет exe на Windows и кладёт его
в черновик релиза `windows-test`.

## Разработка на Mac

Сервер работает и на Mac. `SLOVO_BIN_DIR` указывает на папку с `ffmpeg` и `whisper-cli`, `SLOVO_HOME` на папку данных,
а `--no-window` не открывает окно:

    cd windows && SLOVO_HOME=/tmp/slovo SLOVO_BIN_DIR=/path/to/tools go run . --no-window

Страница открывается по адресу `http://127.0.0.1:47913/`. Тесты: `node windows/test/transform.test.mjs` проверяет
регистр, знаки и правки (перенос `TextTransformerTests`), `windows/test/e2e.ps1` проверяет exe на Windows.
