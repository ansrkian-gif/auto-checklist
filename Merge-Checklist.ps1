param(
    [Parameter(Mandatory = $true)]
    [string]$InputPath,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath
)

$ErrorActionPreference = "Stop"

function Get-ChecklistType([string]$Name) {
    if ($Name -match "Active_Smaacro") { return "Active_Smaacro" }
    if ($Name -match "Passive_General") { return "Passive_General" }
    if ($Name -match "Active_General") { return "Active_General" }
    return $null
}

function Get-ChecklistVersion([string]$Name) {
    if ($Name -match "_v(\d+)\s*$") { return [int]$Matches[1] }
    return 0
}

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

    $grouped = @{}
    $ignored = @()

    foreach ($worksheet in @($workbook.Worksheets)) {
        $typeName = Get-ChecklistType $worksheet.Name
        if (-not $typeName) {
            $ignored += $worksheet.Name
            continue
        }

        $used = $worksheet.UsedRange
        $rowCount = [int]$used.Rows.Count
        $colCount = [int]$used.Columns.Count
        $values = $used.Value2
        $formats = $used.NumberFormat

        $columns = New-Object System.Collections.Generic.List[object]
        $occurrence = @{}
        $removedPhoto = New-Object System.Collections.Generic.List[string]

        for ($col = 1; $col -le $colCount; $col++) {
            $raw = Get-MatrixCell $values 1 $col $rowCount $colCount
            $header = if ($null -eq $raw) { "" } else { [string]$raw }
            $header = $header.Trim()
            if ([string]::IsNullOrWhiteSpace($header)) { continue }
            if ($header -match "Photo") {
                $removedPhoto.Add($header)
                continue
            }

            $norm = Get-HeaderKey $header
            if (-not $occurrence.ContainsKey($norm)) { $occurrence[$norm] = 0 }
            $occurrence[$norm]++
            $key = "{0}|#{1}" -f $norm, $occurrence[$norm]

            $format = "General"
            if ($rowCount -ge 2) {
                $formatCell = Get-MatrixCell $formats 2 $col $rowCount $colCount
                if ($formatCell -is [string] -and $formatCell) { $format = $formatCell }
            }

            $cellValues = New-Object System.Collections.Generic.List[object]
            for ($row = 2; $row -le $rowCount; $row++) {
                $cellValues.Add((Get-MatrixCell $values $row $col $rowCount $colCount))
            }

            $columns.Add([pscustomobject]@{
                Key     = $key
                Name    = $header
                Format  = $format
                Values  = $cellValues
            })
        }

        $dataRows = [Math]::Max(0, $rowCount - 1)
        $entry = [pscustomobject]@{
            Name          = $worksheet.Name
            Version       = Get-ChecklistVersion $worksheet.Name
            Columns       = $columns
            DataRows      = $dataRows
            RemovedPhoto  = $removedPhoto
        }

        if (-not $grouped.ContainsKey($typeName)) {
            $grouped[$typeName] = New-Object System.Collections.Generic.List[object]
        }
        $grouped[$typeName].Add($entry)
    }

    $workbook.Close($false)
    $workbook = $null

    $outWorkbook = $excel.Workbooks.Add()
    while ($outWorkbook.Worksheets.Count -gt 1) {
        $outWorkbook.Worksheets.Item($outWorkbook.Worksheets.Count).Delete()
    }

    $typeOrder = @("Active_General", "Passive_General", "Active_Smaacro")
    $sheetIndex = 0
    $summary = @()

    foreach ($typeName in $typeOrder) {
        if (-not $grouped.ContainsKey($typeName)) { continue }

        $sheets = @($grouped[$typeName] | Sort-Object Version, Name)
        $sheetCount = $sheets.Count

        $order = New-Object System.Collections.Generic.List[string]
        $seen = @{}
        $present = @{}
        $display = @{}
        $formatByKey = @{}

        foreach ($sheet in $sheets) {
            $keysInSheet = @{}
            foreach ($column in $sheet.Columns) {
                $keysInSheet[$column.Key] = $true
                if (-not $seen.ContainsKey($column.Key)) {
                    $seen[$column.Key] = $true
                    $order.Add($column.Key)
                    $display[$column.Key] = $column.Name
                    $formatByKey[$column.Key] = $column.Format
                }
            }
            foreach ($key in $keysInSheet.Keys) {
                if (-not $present.ContainsKey($key)) { $present[$key] = 0 }
                $present[$key]++
            }
        }

        $common = New-Object System.Collections.Generic.List[string]
        $different = New-Object System.Collections.Generic.List[string]
        foreach ($key in $order) {
            if ($present[$key] -eq $sheetCount) { $common.Add($key) }
            else { $different.Add($key) }
        }
        $finalKeys = New-Object System.Collections.Generic.List[string]
        foreach ($key in $common) { $finalKeys.Add($key) }
        foreach ($key in $different) { $finalKeys.Add($key) }

        $outRows = New-Object System.Collections.Generic.List[object]
        foreach ($sheet in $sheets) {
            $byKey = @{}
            foreach ($column in $sheet.Columns) { $byKey[$column.Key] = $column }
            for ($rowIndex = 0; $rowIndex -lt $sheet.DataRows; $rowIndex++) {
                $rowValues = New-Object System.Collections.Generic.List[object]
                $any = $false
                foreach ($key in $finalKeys) {
                    $value = $null
                    if ($byKey.ContainsKey($key)) {
                        $value = $byKey[$key].Values[$rowIndex]
                    }
                    if ($null -ne $value -and "$value" -ne "") { $any = $true }
                    $rowValues.Add($value)
                }
                if ($any) { $outRows.Add($rowValues) }
            }
        }

        $sheetIndex++
        if ($sheetIndex -eq 1) {
            $outSheet = $outWorkbook.Worksheets.Item(1)
            $outSheet.Name = $typeName
        }
        else {
            $outSheet = $outWorkbook.Worksheets.Add([Type]::Missing, $outWorkbook.Worksheets.Item($outWorkbook.Worksheets.Count))
            $outSheet.Name = $typeName
        }

        $colTotal = $finalKeys.Count
        $rowTotal = $outRows.Count + 1
        if ($colTotal -lt 1) { $colTotal = 1 }

        $grid = New-Object "object[,]" $rowTotal, $colTotal
        for ($colIndex = 0; $colIndex -lt $finalKeys.Count; $colIndex++) {
            $grid[0, $colIndex] = $display[$finalKeys[$colIndex]]
        }
        for ($rowIndex = 0; $rowIndex -lt $outRows.Count; $rowIndex++) {
            $rowValues = $outRows[$rowIndex]
            for ($colIndex = 0; $colIndex -lt $finalKeys.Count; $colIndex++) {
                $targetRow = $rowIndex + 1
                $grid[$targetRow, $colIndex] = $rowValues[$colIndex]
            }
        }

        $target = $outSheet.Range(
            $outSheet.Cells.Item(1, 1),
            $outSheet.Cells.Item($rowTotal, $colTotal)
        )
        $target.Value2 = $grid

        for ($colIndex = 0; $colIndex -lt $finalKeys.Count; $colIndex++) {
            $fmt = $formatByKey[$finalKeys[$colIndex]]
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

        $photoCount = ($sheets | ForEach-Object { $_.RemovedPhoto.Count } | Measure-Object -Sum).Sum
        $summary += [pscustomobject]@{
            Type             = $typeName
            SourceSheets     = ($sheets.Name -join ", ")
            Rows             = $outRows.Count
            Columns          = $finalKeys.Count
            CommonColumns    = $common.Count
            DifferentColumns = $different.Count
            PhotoRemoved     = $photoCount
        }
    }

    $outDir = Split-Path -Parent $OutputPath
    if ($outDir -and -not (Test-Path -LiteralPath $outDir)) {
        New-Item -ItemType Directory -Path $outDir | Out-Null
    }
    if (Test-Path -LiteralPath $OutputPath) {
        Remove-Item -LiteralPath $OutputPath -Force
    }
    $outWorkbook.SaveAs($OutputPath, 51)
    $saved = $true
    $outWorkbook.Close($true)
    $outWorkbook = $null

    Write-Output "IGNORED|$($ignored -join ', ')"
    foreach ($item in $summary) {
        Write-Output ("RESULT|{0}|sources={1}|rows={2}|columns={3}|common={4}|different={5}|photoRemoved={6}" -f $item.Type, $item.SourceSheets, $item.Rows, $item.Columns, $item.CommonColumns, $item.DifferentColumns, $item.PhotoRemoved)
    }
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
