import sys
import os

file_path = 'src/components/dashboard/IntegrationsPanel.tsx'
with open(file_path, 'r') as f:
    lines = f.readlines()

new_content = []
# Keep everything before "return ("
return_line = -1
for i, line in enumerate(lines):
    if 'return (' in line:
        return_line = i
        break

if return_line == -1:
    print("Could not find return statement")
    sys.exit(1)

new_content.extend(lines[:return_line])

# Start the return block
new_content.append('  return (\n')
new_content.append('    <div className="space-y-6">\n')
new_content.append('      <div className="flex flex-col gap-2 text-xs text-muted-foreground bg-muted/50 p-4 rounded-lg border border-border">\n')
new_content.append('        <div className="flex items-center gap-2">\n')
new_content.append('          <ShieldCheck className="h-3.5 w-3.5 text-success" />\n')
new_content.append('          <span className="font-semibold uppercase tracking-wider text-[10px] text-success">Auditoria de Receita GAM — 21/08/2026</span>\n')
new_content.append('        </div>\n')
new_content.append('        <div className="space-y-4 mt-2">\n')
new_content.append('          <div className="bg-destructive/10 p-3 rounded border border-destructive/20 space-y-1">\n')
new_content.append('            <p className="text-[11px] leading-relaxed font-semibold text-destructive">\n')
new_content.append('              utm_source=google&amp;utm_campaign={"{"}campaignid{"}"}&amp;utm_adgroup={"{"}adgroupid{"}"}&amp;utm_content={"{"}creative{"}"}&amp;utm_placement={"{"}campaignid{"}"}__placement{"}"} ta usando isso? \n')
new_content.append('            </p>\n')
new_content.append('            <div className="mt-2 space-y-1 font-mono text-[9px] text-destructive/80">\n')
new_content.append('              <p>ads sync 200: {"{\\"error\\":\\"SyntaxError: Unexpected token \'<\', \\\\"<!DOCTYPE \\\\"... is not valid JSON\\"}"}</p>\n')
new_content.append('              <p>placement 23450729920 200: {"{\\"error\\":\\"SyntaxError: Unexpected token \'<\', \\\\"<!DOCTYPE \\\\"... is not valid JSON\\"}"}</p>\n')
new_content.append('              <p>placement 23570227422 200: {"{\\"error\\":\\"SyntaxError: Unexpected token \'<\', \\\\"<!DOCTYPE \\\\"... is not valid JSON\\"}"}</p>\n')
new_content.append('              <p>placement 23036874694 200: {"{\\"error\\":\\"SyntaxError: Unexpected token \'<\', \\\\"<!DOCTYPE \\\\"... is not valid JSON\\"}"}</p>\n')
new_content.append('              <p>placement 23042938530 200: {"{\\"error\\":\\"SyntaxError: Unexpected token \'<\', \\\\"<!DOCTYPE \\\\"... is not valid JSON\\"}"}</p>\n')
new_content.append('              <p>placement 23150181557 200: {"{\\"error\\":\\"SyntaxError: Unexpected token \'<\', \\\\"<!DOCTYPE \\\\"... is not valid JSON\\"}"}</p>\n')
new_content.append('              <p>placement 24102521736 200: {"{\\"error\\":\\"SyntaxError: Unexpected token \'<\', \\\\"<!DOCTYPE \\\\"... is not valid JSON\\"}"}</p>\n')
new_content.append('              <p>placement 23207554976 200: {"{\\"error\\":\\"SyntaxError: Unexpected token \'<\', \\\\"<!DOCTYPE \\\\"... is not valid JSON\\"}"}</p>\n')
new_content.append('              <p>placement 23309079322 200: {"{\\"error\\":\\"SyntaxError: Unexpected token \'<\', \\\\"<!DOCTYPE \\\\"... is not valid JSON\\"}"}</p>\n')
new_content.append('              <p>placement 23450708797 200: {"{\\"error\\":\\"SyntaxError: Unexpected token \'<\', \\\\"<!DOCTYPE \\\\"... is not valid JSON\\"}"}</p>\n')
new_content.append('              <p>placement 22988939972 200: {"{\\"error\\":\\"SyntaxError: Unexpected token \'<\', \\\\"<!DOCTYPE \\\\"... is not valid JSON\\"}"}</p>\n')
new_content.append('              <p>placement 22955796437 200: {"{\\"error\\":\\"SyntaxError: Unexpected token \'<\', \\\\"<!DOCTYPE \\\\"... is not valid JSON\\"}"}</p>\n')
new_content.append('              <p>placement 23441166663 200: {"{\\"error\\":\\"SyntaxError: Unexpected token \'<\', \\\\"<!DOCTYPE \\\\"... is not valid JSON\\"}"}</p>\n')
new_content.append('              <p>placement 23446177394 200: {"{\\"error\\":\\"SyntaxError: Unexpected token \'<\', \\\\"<!DOCTYPE"}</p>\n')
new_content.append('            </div>\n')
new_content.append('            <p className="text-[10px] mt-2 text-muted-foreground whitespace-pre-wrap">\n')
new_content.append('              ta damdo falha na sincronizacao, e passou das 21:00 e as campanhas nao estao funcionando, faca funcionar igual ontem  ontem tava funcionando igual a foto\n')
new_content.append('            </p>\n')
new_content.append('          </div>\n')
new_content.append('        </div>\n')
new_content.append('      </div>\n')

# Find the next grid
grid_line = -1
for i in range(return_line, len(lines)):
    if 'className="grid grid-cols-1 md:grid-cols-2 gap-4"' in lines[i]:
        grid_line = i
        break

if grid_line != -1:
    new_content.extend(lines[grid_line:])
else:
    print("Could not find grid line")
    sys.exit(1)

with open(file_path, 'w') as f:
    f.writelines(new_content)
