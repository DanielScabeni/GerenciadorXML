@echo off
setlocal enabledelayedexpansion
rem alterado nomes de variaveis caminhos e textos padrao
rem alterado mensagens exibidas no loop de verificacao de diretorios e ao copiar aquivos, agora com mais informacoes
rem Opcao de copiar apenas intervalo de dias especificos que tinha em um arquivo separado agora foi totalmente unificado como uma opcao 
rem implementado verificacoes para o filtro de data limite, para que nao de erro ao estourar o ultimo dia do mes
rem nome do arquivo compactado agora tera os dias do intervalo caso o mesmo for definido quando solicitado
rem adicionado verificacao para excluir pastar criadas no destino que nao possui nenhum XML copiado para a mesma
rem Corrigido e adicionado a verificacao de mes e dia com apenas 1 digito. Sera concatenado 0 a esquerda se tiver 1 digito, precisa ser MM e DD
rem adicionado mensagem final de verificacao quando nenhum arquivo for copiado, mostrando tambem os diretorios buscados
rem Ajustado verificacoes de pastas e diretorios vazios criados, e mensagens exibidas no prompt
rem CORRIGIDO: Problema do cedilha em Marco e calculo do mes anterior quando e Janeiro

echo [O arquivo deve ser executado na raiz de Unimake, ou onde estiverem as pastas (UniNFe) e (Uninfce)]
echo.

rem Obtem o ano e o mes atuais
for /f "tokens=1-2" %%A in ('wmic path win32_localtime get year^,month ^| findstr /r /v "^$"') do (
    set "ano_atual=%%B"
    set "mes_atual=%%A"
)

rem Solicitar o mes ao usuario (usando o mes anterior ao atual como padrao)
set /a "mes_anterior=mes_atual-1"

rem Garantir mes anterior correto se for mes 01 (Janeiro)
if !mes_anterior! leq 0 (
    set /a "ano_anterior=ano_atual-1"
    set "mes_anterior=12"
) else (
    set "ano_anterior=!ano_atual!"
)

rem Adicionar zero a esquerda se necessario
if !mes_anterior! lss 10 (
    set "mes_anterior=0!mes_anterior!"
)

rem Solicitar o ano ao usuario (usando o ano anterior se mes for dezembro)
set /p "ano=Digite o ano (YYYY), Enter para usar (%ano_anterior%): "
if not defined ano set "ano=!ano_anterior!"

set /p "mes=Digite o mes (MM), Enter para usar o anterior (%mes_anterior%): "
if not defined mes set "mes=!mes_anterior!"

rem impedir que mes so tenha um digito e alimentar variaveis para o filtro de data limite (precisa ter 1 a mais que definido)
if "!mes:~1,1!"=="" set "mes=0!mes!"
set "mes_fim=!mes!"
set "ano_fim=!ano!"

rem Solicitar ao usuario se deseja filtrar por intervalo de datas
set /p "filtrar_datas=Filtrar arquivos por intervalo de dias especifico no mes? (S) sim (Enter p/ pegar do mes todo): "
if /i "%filtrar_datas%"=="S" (
    echo.
    set /p "dia_inicio=Digite o primeiro dia (DD) do intervalo (filtrar desde o dia...): "
    set /p "dia_termino=Digite o ultimo dia (DD) do intervalo (filtrar ate o dia...): "

    rem Impede que o dia no filtro fique vazio (null)
    if not defined dia_inicio set "dia_inicio=01"
    if not defined dia_termino set "dia_termino=31"

    rem Incrementar 1 no dia_termino para incluir o ultimo dia do intervalo na filtragem (data termino e um menor que)
    rem e utilizado outra variavel para tratar o dia incrementado e utilizar o dia informado em outros filtros
    set /a "dia_fim=dia_termino+1"

    rem concatenar 0 se o dia for menor que 10, pois precisa ter 2 digitos
    if "!dia_inicio:~1,1!"=="" set "dia_inicio=0!dia_inicio!"
    if "!dia_termino:~1,1!"=="" set "dia_termino=0!dia_termino!"
    if "!dia_fim:~1,1!"=="" set "dia_fim=0!dia_fim!"
)

rem Converter o numero do mes em um nome de mes e defini o ultimo dia do mes de acordo com o mesmo
rem CORRIGIDO: Removido cedilha de Marco para evitar problemas de encoding
set "nome_mes="
set "ultimo_dia="
if "%mes%"=="01" (
    set "nome_mes=Janeiro"
    set "ultimo_dia=31"
)
if "%mes%"=="02" (
    set "nome_mes=Fevereiro"
    set "ultimo_dia=28"
    rem Verifica se o ano e Bissexto comparando resto de divisao por 4
    set /a "ano_resto_div_4=!ano! %% 4"
    if "!ano_resto_div_4!"=="0" (
        set "ultimo_dia=29"
    )
)
if "%mes%"=="03" (
    set "nome_mes=Marco"
    set "ultimo_dia=31"
)
if "%mes%"=="04" (
    set "nome_mes=Abril"
    set "ultimo_dia=30"
)
if "%mes%"=="05" (
    set "nome_mes=Maio"
    set "ultimo_dia=31"
)
if "%mes%"=="06" (
    set "nome_mes=Junho"
    set "ultimo_dia=30"
)
if "%mes%"=="07" (
    set "nome_mes=Julho"
    set "ultimo_dia=31"
)
if "%mes%"=="08" (
    set "nome_mes=Agosto"
    set "ultimo_dia=31"
)
if "%mes%"=="09" (
    set "nome_mes=Setembro"
    set "ultimo_dia=30"
)
if "%mes%"=="10" (
    set "nome_mes=Outubro"
    set "ultimo_dia=31"
)
if "%mes%"=="11" (
    set "nome_mes=Novembro"
    set "ultimo_dia=30"
)
if "%mes%"=="12" (
    set "nome_mes=Dezembro"
    set "ultimo_dia=31"
)

rem Obter o caminho da pasta Unimake (onde o script devera estar)
set "raiz_unimake=%~dp0"

rem Pasta de origem 1 - NF-e
set "uninfe=%raiz_unimake%UniNFe"
rem Pasta de origem 2 - NFC-e
set "uninfce=%raiz_unimake%Uninfce"

rem Monta o caminho e o nome da pasta destino de acordo com o dia se tiver intervalo, o mes e o ano
if /i "%filtrar_datas%"=="S" (
    if "%dia_inicio%"=="%dia_termino%" (
        set "destino=%raiz_unimake%XML !dia_inicio! !nome_mes! %ano%"
    ) else (
        set "destino=%raiz_unimake%XML !dia_inicio!-!dia_termino! !nome_mes! %ano%"
    )
) else (
    set "destino=%raiz_unimake%XML !nome_mes! %ano%"
)

rem Verificar se o dia_termino fornecido e maior que o ultimo dia do mes
if defined dia_fim (
    if !dia_fim! gtr !ultimo_dia! (
        set "dia_fim=01"
        set /a "mes_fim=!mes!+1"
        if "!mes_fim!"=="13" (
            set "mes_fim=01"
            set /a "ano_fim=!ano!+1"
        )
        rem deixa o mes usado na data final com 2 digitos caso tenha so 1
        if "!mes_fim:~1,1!"=="" set "mes_fim=0!mes_fim!"
    )
)

rem monta a data inicial e final do intervalo
if /i "%filtrar_datas%"=="S" (
    set "data_inicio=!ano!!mes!!dia_inicio!"
    set "data_termino=!ano_fim!!mes_fim!!dia_fim!"
)

echo.

rem Caminho para o executavel do 7-Zip
set "setezip=C:\Program Files\7-Zip\7z.exe"
rem Caminho para o executavel do WinRAR
set "winrar=C:\Program Files\WinRAR\winrar.exe"

rem Verificar se o WinRAR esta instalado
if not exist "%winrar%" (
    rem Verificar se o 7-Zip esta instalado
    if not exist "%setezip%" (
        echo.
        echo Nenhum dos compactadores WinRAR e 7-Zip foi encontrado.
        echo Os arquivos serao apenas copiados para: "!destino!".
        pause
    )
)

rem Criar a pasta de destino se ela nao existir
if not exist "!destino!\" mkdir "!destino!"

cls

rem Contador de pastas encontradas e processadas
set "pastas_encontradas_nfe=0"
set "pastas_encontradas_nfce=0"
set "pastas_com_arquivos=0"
set "total_arquivos_encontrados=0"
set "total_arquivos_copiados=0"

rem Loop atraves das pastas dos CNPJ no primeiro caminho (NF-e)
for /d %%D in ("%uninfe%\*") do (
    rem Verifique se e uma pasta com um numero com 14 digitos (CNPJ)
    set "cnpj=%%~nxD"
    set "eh_cnpj=0"
    
    rem Verifica se tem exatamente 14 caracteres e se todos sao numeros
    if "!cnpj:~14,1!"=="" if not "!cnpj:~13,1!"=="" (
        set "eh_cnpj=1"
        for /f "delims=0123456789" %%a in ("!cnpj!") do set "eh_cnpj=0"
    )
    
    if "!eh_cnpj!"=="1" (
        rem Construir o caminho completo da pasta a ser copiada
        set "caminho_uninfe=%%D\Enviado\Autorizados\!ano!!mes!"

        rem Verificar se a pasta de origem existe
        if exist "!caminho_uninfe!\" (
            set /a "pastas_encontradas_nfe+=1"
            
            rem Contar total de arquivos XML na pasta de origem
            set "total_arquivos=0"
            for /r "!caminho_uninfe!" %%f in (*.xml) do (
                set /a "total_arquivos+=1"
            )
            
            set /a "total_arquivos_encontrados+=total_arquivos"
            
            rem Criar uma pasta de destino dos XML de NF-e para cada CNPJ
            set "pasta_destino=!destino!\NF-e !cnpj!"
            if not exist "!pasta_destino!\" mkdir "!pasta_destino!"

            echo Copiando arquivos de NF-e do CNPJ [!cnpj!].
            
            rem Define o comando de copiar os arquivos da pasta origem para destino e adiciona o filtro de datas no caso de escolhido
            rem CORRIGIDO: invertido minage e maxage
            set "robocopy_command=robocopy "!caminho_uninfe!" "!pasta_destino!" *.xml /s /nc /ndl /np /xa:hs"
            if /i "%filtrar_datas%"=="S" (
                set "robocopy_command=!robocopy_command! /minage:!data_inicio! /maxage:!data_termino!"
            )

            rem Copie os arquivos da pasta de origem para a pasta de destino
            !robocopy_command! > temp_nfe_!cnpj!.txt

            rem Encontre a linha que contem o total de arquivos copiados com o robocopy e exibe
            set "num_copiados=0"
            for /f "tokens=2" %%A in ('type temp_nfe_!cnpj!.txt ^| findstr /C:"Arquivos:"') do (
                set "num_copiados=%%A"
            )

            set /a "total_arquivos_copiados+=num_copiados"
            
            echo Numero de arquivos copiados: !num_copiados!
            
            if !num_copiados! gtr 0 (
                set /a "pastas_com_arquivos+=1"
            )
            
            del temp_nfe_!cnpj!.txt
        )
    )
)

echo.
echo --------------------------------------------------------------------------------------------------------------

rem Loop atraves das pastas dos CNPJ no segundo caminho (NFC-e)
for /d %%D in ("%uninfce%\*") do (
    rem Verifique se e uma pasta com um numero com 14 digitos (CNPJ)
    set "cnpj=%%~nxD"
    set "eh_cnpj=0"
    
    rem Verifica se tem exatamente 14 caracteres e se todos sao numeros
    if "!cnpj:~14,1!"=="" if not "!cnpj:~13,1!"=="" (
        set "eh_cnpj=1"
        for /f "delims=0123456789" %%a in ("!cnpj!") do set "eh_cnpj=0"
    )
    
    if "!eh_cnpj!"=="1" (
        rem Construir o caminho completo da pasta a ser copiada
        set "caminho_uninfce=%%D\Enviado\Autorizados\!ano:~-2!!mes!"

        rem Verificar se a pasta de origem existe
        if exist "!caminho_uninfce!\" (
            set /a "pastas_encontradas_nfce+=1"
            
            rem Contar total de arquivos XML na pasta de origem
            set "total_arquivos=0"
            for /r "!caminho_uninfce!" %%f in (*.xml) do (
                set /a "total_arquivos+=1"
            )
            
            set /a "total_arquivos_encontrados+=total_arquivos"
            
            rem Criar uma pasta de destino dos XML de NFC-e para cada CNPJ
            set "pasta_destino=!destino!\NFC-e !cnpj!"
            if not exist "!pasta_destino!\" mkdir "!pasta_destino!"

            echo Copiando arquivos de NFC-e do CNPJ [!cnpj!].
            
            rem Define o comando de copiar os arquivos da pasta origem para destino e adiciona o filtro de datas no caso de escolhido
            rem CORRIGIDO: invertido minage e maxage
            set "robocopy_command=robocopy "!caminho_uninfce!" "!pasta_destino!" *.xml /s /nc /ndl /np /xa:hs"
            if /i "%filtrar_datas%"=="S" (
                set "robocopy_command=!robocopy_command! /minage:!data_inicio! /maxage:!data_termino!"
            )
            
            rem Copie os arquivos da pasta de origem para a pasta de destino
            !robocopy_command! > temp_nfce_!cnpj!.txt
            
            rem Encontre a linha que contem o total de arquivos copiados com o robocopy e exibe
            set "num_copiados=0"
            for /f "tokens=2" %%A in ('type temp_nfce_!cnpj!.txt ^| findstr /C:"Arquivos:"') do (
                set "num_copiados=%%A"
            )

            set /a "total_arquivos_copiados+=num_copiados"
            
            echo Numero de arquivos copiados: !num_copiados!
            
            if !num_copiados! gtr 0 (
                set /a "pastas_com_arquivos+=1"
            )
            
            del temp_nfce_!cnpj!.txt
        )
    )
)

echo.
echo Validando arquivos copiados...
echo.
echo ==================== RESUMO GERAL ====================
echo Pastas de CNPJ NF-e encontradas: !pastas_encontradas_nfe!
echo Pastas de CNPJ NFC-e encontradas: !pastas_encontradas_nfce!
echo Pastas com arquivos copiados: !pastas_com_arquivos!
echo Total de arquivos XML copiados: !total_arquivos_copiados!
echo ======================================================
echo.

rem Verifica se foi criado alguma pasta no destino sem ter copiado nenhum arquivo para ele, e exclui
for /d %%i in ("!destino!\*") do (
    set "vazio=true"

    dir /b "%%i" 2>nul | find /v /c "" > temp_count.txt
    set /p fileCount=<temp_count.txt
    del temp_count.txt

    if !fileCount! gtr 0 (
        set "vazio=false"
    )
    if !vazio!==true (
        echo Removendo pasta vazia: %%i
        rmdir "%%i" /s /q
    )
)

rem Verifica se a pasta de destino dos arquivos nao esta vazio (se por ventura nao foi copiado nenhum XML)
set "vazio=true"
for /f %%a in ('dir /b "!destino!" 2^>nul') do (
    set "vazio=false"
    goto :nao_vazio
)
:nao_vazio

echo --------------------------------------------------------------------------------------------------------------
        
rem Exibe no prompt o periodo de acordo e remove a pasta vazia criada no destino 
if !vazio!==true (
    if /i "%filtrar_datas%"=="S" (
        echo Nao foi encontrado nenhum Arquivo do dia [!dia_inicio! a !dia_termino!] do mes [!mes!] e ano [!ano!].
        echo Data do filtro: inicial [!data_inicio!] final [!data_termino!]
    ) else (
        echo Nao foi encontrado nenhum Arquivo para o mes [!mes!] e ano [!ano!].
    )
    echo Caminhos buscados: 
    echo   NF-e:  [!uninfe!\*\Enviado\Autorizados\!ano!!mes!]
    echo   NFC-e: [!uninfce!\*\Enviado\Autorizados\!ano:~-2!!mes!]
    echo.
    pause
    rd /s /q "!destino!"
) else (
    rem Verificar se o WinRAR esta instalado
    if exist "%winrar%" (
        rem Compactar a pasta de destino principal com o WinRAR e depois deletar a pasta temporaria 
        "%winrar%" a -ep1 -r "!destino!.rar" "!destino!\*.*"
        rd /s /q "!destino!"
        echo Arquivos XML de todos os CNPJ que os possuem no periodo foram compactados com WinRAR para:
        echo [!destino!.rar]
    ) else (
        rem Verificar se o 7-Zip esta instalado
        if exist "%setezip%" (
            rem Compactar a pasta de destino principal com o 7-Zip e depois deletar a pasta temporaria 
            "%setezip%" a -r -tzip "!destino!.zip" "!destino!\*.*" > nul
            rd /s /q "!destino!"
            echo Arquivos XML de todos os CNPJ que os possuem no periodo foram compactados com 7-Zip para:
            echo [!destino!.zip]
        ) else (
            echo 7-Zip e WinRAR nao encontrados... Arquivos XML de todos os CNPJ que os possuem no periodo foram apenas copiados para: 
            echo [!destino!]
        )
    )
    echo.
    pause
)
endlocal