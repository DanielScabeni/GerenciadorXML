# Compactar XML V4 - GUI

Aplicacao desktop para localizar e exportar XMLs de NF-e, NFC-e e CT-e a partir da estrutura da Unimake.

## Recursos
- Configuracao da pasta base (raiz com `UniNFe` e `Uninfce`) com persistencia em `%APPDATA%\\CompactarXMLV4\\config.json`.
- Primeira execucao sem configuracao: busca automatica em diretorios padrao (`C:\Unimake`, `D:\Unimake`, etc.) e confirmacao com o usuario.
- Botao `Testar estrutura` para validar pastas e padrao de diretorios (`CNPJ/Enviado/Autorizados`).
- Selecao de data inicial e final com calendario popup (`...`) e botoes `Hoje`/`Limpar`.
- Grid em arvore por CNPJ com toggle nativo e linhas de nota contendo tipo, numero, serie e chave de acesso.
- Checkbox por linha de XML, por CNPJ e no topo da coluna para marcar/desmarcar em lote.
- Botao `Salvar marcados (ZIP)` para gerar um unico arquivo com todos os XMLs selecionados.
- Filtro por numero de documento.
- Duplo clique na nota para salvar copia individual do XML.
- Clique com botao direito na nota para abrir o local do arquivo no Explorer.
- Painel ajustavel com divisor arrastavel entre grid e log.
- Preferencia automatica por arquivos `proc*` quando existe mais de um XML para a mesma chave.

## Executar em modo script
```bat
python xml_explorer_gui.py
```

## Gerar executavel
1. Instale o PyInstaller (uma vez):
```bat
python -m pip install pyinstaller
```
2. Rode:
```bat
build_exe.bat
```
3. O executavel sera criado em:
```text
dist\\CompactarXMLGUI.exe
```
