# Converts one document with Microsoft Word (Windows only).
#   powershell -NoProfile -ExecutionPolicy Bypass -File word-convert.ps1 <input> <output> <pdf|docx>
# The caller runs one Word process per file and kills it on timeout, because Word can
# block forever on a hidden dialog. Macros are disabled and password prompts are
# answered with a dummy password so they fail instead of waiting.
param(
  [Parameter(Mandatory = $true)][string]$InputPath,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [Parameter(Mandatory = $true)][ValidateSet("pdf", "docx")][string]$Format
)
$ErrorActionPreference = "Stop"
$word = $null
$doc = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $word.AutomationSecurity = 3
  # FileName, ConfirmConversions, ReadOnly, AddToRecentFiles, PasswordDocument, PasswordTemplate, Revert
  $doc = $word.Documents.OpenNoRepairDialog($InputPath, $false, $true, $false, "gp-no-password", "gp-no-password", $true)
  if ($Format -eq "pdf") {
    # 17 = wdExportFormatPDF; keep bookmarks out of the PDF outline.
    $doc.ExportAsFixedFormat($OutputPath, 17, $false, 0, 0, 1, 1, 0, $true, $true, 0, $true, $true, $false)
  } else {
    # 16 = wdFormatDocumentDefault (.docx)
    $doc.SaveAs2($OutputPath, 16)
  }
  $pages = $doc.ComputeStatistics(2)
  Write-Output "pages=$pages"
} finally {
  if ($doc) { $doc.Close(0) | Out-Null }
  if ($word) { $word.Quit() | Out-Null }
}
