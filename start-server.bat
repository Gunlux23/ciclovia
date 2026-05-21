@echo off
REM Avvia il server locale per Ciclovia usando il Python di WSL.
REM Doppio click su questo file per lanciarlo.
REM Per fermare il server: chiudi questa finestra.

title Ciclovia - server locale

echo ==========================================
echo  Ciclovia - server locale
echo ==========================================
echo.
echo  URL sul PC:    http://localhost:8000
echo.
echo  Per fermare il server: chiudi questa finestra.
echo ==========================================
echo.

wsl --cd /mnt/c/Users/Utente/.claude/progettiClaude/ciclovia python3 -m http.server 8000 --bind 0.0.0.0

echo.
echo Server terminato.
pause
