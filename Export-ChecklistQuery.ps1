param(
    [Parameter(Mandatory = $true)]
    [string]$InputPath,

    [Parameter(Mandatory = $true)]
    [string]$SourceSheet,

    [Parameter(Mandatory = $true)]
    [string]$QueryName,

    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,

    [Parameter(Mandatory = $true)]
    [string[]]$ContentColumns
)

$ErrorActionPreference = "Stop"

$CommonColumns = @("Task ID", "Site ID", "Operate Time")

function Get-HeaderKey([string]$Text) {
    $trimmed = ($Text -replace "\s+", " ").Trim()
    return $trimmed.ToLowerInvariant()
}

function Get-MatrixCell($Matrix, [int]$Row, [int]$Col, [int]$RowCount, [int]$ColCount) {
    if ($RowCount -eq 1 -and $ColCount -eq 1) { return $Matrix }
    return $Matrix[$Row, $Col]
}

function Release-ComObject($Object) {
    if ($null -ne $Object) {
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($Object)
    }
}

$excel = $null
$workbook = $null
$outWorkbook = $null
$saved = $false

try {
    $excel = New-Object -ComObject Excel.Application
    $excel.Visible = $false
    $excel.DisplayAlerts = $false
    $excel.ScreenUpdating = $false

    $workbook = $excel.Workbooks.Open((Resolve-Path -LiteralPath $InputPath).Path, $null, $true)
    $worksheet = $null
    foreach ($candidate in @($workbook.Worksheets)) {
        if ($candidate.Name -eq $SourceSheet) {
            $worksheet = $candidate
            break
        }
    }
    if (-not $worksheet) {
        $available = @($workbook.Worksheets | ForEach-Object { $_.Name }) -join ", "
        throw "Sheet '$SourceSheet' was not found. Available sheets: $available"
    }

    $used = $worksheet.UsedRange
    $rowCount = [int]$used.Rows.Count
    $colCount = [int]$used.Columns.Count
    $values = $used.Value2

    $headerIndex = @{}
    for ($col = 1; $col -le $colCount; $col++) {
        $raw = Get-MatrixCell $values 1 $col $rowCount $colCount
        $header = if ($null -eq $raw) { "" } else { ([string]$raw).Trim() }
        if ([string]::IsNullOrWhiteSpace($header)) { continue }
        $key = Get-HeaderKey $header
        if (-not $headerIndex.ContainsKey($key)) {
            $headerIndex[$key] = New-Object System.Collections.Generic.List[int]
        }
        $headerIndex[$key].Add($col)
    }

    $selected = New-Object System.Collections.Generic.List[object]
    foreach ($name in ($CommonColumns + $ContentColumns)) {
        $key = Get-HeaderKey $name
        if (-not $headerIndex.ContainsKey($key)) {
            throw "Column '$name' was not found on $SourceSheet."
        }
        $sourceCol = $headerIndex[$key][0]
        $format = "General"
        if ($rowCount -ge 2) {
            $format = [string]$worksheet.Cells.Item(2, $sourceCol).NumberFormat
            if ([string]::IsNullOrWhiteSpace($format)) { $format = "General" }
        }
        $selected.Add([pscustomobject]@{
            Name      = $name
            SourceCol = $sourceCol
            Format    = $format
        })
    }

    $dataRowCount = [Math]::Max(0, $rowCount - 1)
    $outRowCount = $dataRowCount + 1
    $outColCount = $selected.Count
    $grid = New-Object "object[,]" $outRowCount, $outColCount

    for ($colIndex = 0; $colIndex -lt $outColCount; $colIndex++) {
        $grid[0, $colIndex] = $selected[$colIndex].Name
    }
    for ($row = 2; $row -le $rowCount; $row++) {
        $targetRow = $row - 1
        for ($colIndex = 0; $colIndex -lt $outColCount; $colIndex++) {
            $grid[$targetRow, $colIndex] = Get-MatrixCell $values $row $selected[$colIndex].SourceCol $rowCount $colCount
        }
    }

    $workbook.Close($false)
    $workbook = $null

    $outWorkbook = $excel.Workbooks.Add()
    while ($outWorkbook.Worksheets.Count -gt 1) {
        $outWorkbook.Worksheets.Item($outWorkbook.Worksheets.Count).Delete()
    }
    $outSheet = $outWorkbook.Worksheets.Item(1)
    $sheetName = $QueryName
    if ($sheetName.Length -gt 31) { $sheetName = $sheetName.Substring(0, 31) }
    $outSheet.Name = $sheetName

    $target = $outSheet.Range(
        $outSheet.Cells.Item(1, 1),
        $outSheet.Cells.Item($outRowCount, $outColCount)
    )
    $target.Value2 = $grid

    for ($colIndex = 0; $colIndex -lt $outColCount; $colIndex++) {
        $fmt = $selected[$colIndex].Format
        if ($fmt -and $fmt -ne "General") {
            $outSheet.Columns.Item($colIndex + 1).NumberFormat = $fmt
        }
    }

    $outSheet.Rows.Item(1).Font.Bold = $true
    $outSheet.Rows.Item(1).WrapText = $true
    $outSheet.Rows.Item(1).RowHeight = 32
    $outSheet.UsedRange.ColumnWidth = 22
    $outSheet.Rows.Item(1).AutoFilter() | Out-Null
    $outSheet.Application.ActiveWindow.SplitRow = 1
    $outSheet.Application.ActiveWindow.FreezePanes = $true

    if (-not (Test-Path -LiteralPath $OutputDirectory)) {
        New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
    }
    $outputPath = Join-Path $OutputDirectory ($QueryName + ".xlsx")
    if (Test-Path -LiteralPath $outputPath) {
        Remove-Item -LiteralPath $outputPath -Force
    }
    $outWorkbook.SaveAs($outputPath, 51)
    $saved = $true
    $outWorkbook.Close($true)
    $outWorkbook = $null

    Write-Output "SAVED|$outputPath|rows=$dataRowCount|columns=$outColCount"
}
catch {
    Write-Output "ERROR|$($_.Exception.Message)"
    Write-Output $_.ScriptStackTrace
    throw
}
finally {
    if ($workbook) { $workbook.Close($false) }
    if ($outWorkbook -and -not $saved) { $outWorkbook.Close($false) }
    if ($excel) { $excel.Quit() }
    Release-ComObject $outWorkbook
    Release-ComObject $workbook
    Release-ComObject $excel
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
