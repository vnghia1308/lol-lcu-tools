
"use strict"

const { request, authenticate, connect, LeagueClient } = require('league-connect')
const { dialog, app, BrowserWindow, ipcMain } = require('electron')
const fs = require('fs'), xl = require('excel4node'), exec = require('child_process').exec

/**
 * General data
 */
var IsFirstStart = true, SummonerName = null, IsRunAsAdmin = false, SummonerId = null, AutoSelectChampion = {
    status: false,
    championId: 0
}

exec('NET SESSION', function (err, so, se) {
    IsRunAsAdmin = (se.length === 0)

    if (!IsRunAsAdmin) {
        dialog.showMessageBox({
            type: 'error',
            buttons: ['OK'],
            defaultId: 1,
            title: 'Error',
            message: 'Cannot start this app',
            detail: 'Please run app as administrator (because LeagueClient.exe is administrator proccess)'
        }).then(() => {
            app.quit()
        })
    }
})

/**
 * @private
 **/
async function StartGamePhaseistener(credentials) {
    const ws = await connect(credentials)
    ws.subscribe('/lol-gameflow/v1/gameflow-phase', async (data, event) => {
        if (data == "ChampSelect") {
            if (!AutoSelectChampion.status)
                return

            const response = await request({
                method: 'GET',
                url: '/lol-champ-select/v1/session'
            }, credentials)

            let selectionSession = await response.json()

            let cellId = null
            if ("myTeam" in selectionSession) {
                for (let team of selectionSession["myTeam"]) {
                    if (team.summonerId == SummonerId) {
                        cellId = team.cellId
                        break
                    }
                }
            }

            let actionId = null
            if ("actions" in selectionSession && cellId != null) {
                for (let action of selectionSession["actions"][0]) {
                    if (action.actorCellId == cellId) {
                        actionId = action.id
                        break
                    }
                }
            }

            if (actionId) {
                const actionUrl = '/lol-champ-select/v1/session/actions/' + actionId
                await request({
                    method: 'PATCH',
                    url: actionUrl,
                    body: {
                        "championId": AutoSelectChampion.championId
                    }
                }, credentials)

                await request({
                    method: 'POST',
                    url: actionUrl + "/complete",
                    body: {

                    }
                }, credentials)
            }
        }
    })
}

async function StartLeagueClientListener(credentials) {
    const client = new LeagueClient(credentials)

    client.on('disconnect', () => {
        app.quit()
    })

    client.start()
}

ipcMain.on('request-mainprocess-action', (event, arg) => {
    switch (arg.type) {
        case "change_background":
            (async function () {
                try {
                    const credentials = await authenticate()

                    const response = await request({
                        method: 'POST',
                        url: '/lol-summoner/v1/current-summoner/summoner-profile',
                        body: {
                            "key": "backgroundSkinId",
                            "value": parseInt(arg.skin_id)
                        }
                    }, credentials)

                    event.sender.send('mainprocess-response', "Đã gửi yêu cầu tới máy chủ cục bộ của Liên Minh")
                    event.sender.send('mainprocess-response-json', {
                        skin_id: arg.skin_id,
                        success: "true"
                    })
                } catch {
                    event.sender.send('mainprocess-response-json', {
                        skin_id: "null",
                        success: "false"
                    })
                    event.sender.send('mainprocess-response-error', "Không tìm thấy LeagueClient.exe hoạt động")
                }
            })()
            break;

        case "get_skins_list":
            (async function () {
                try {
                    const credentials = await authenticate()

                    const response = await request({
                        method: 'GET',
                        url: '/lol-catalog/v1/items/CHAMPION_SKIN'
                    }, credentials)

                    let resJson = await response.json()
                    event.sender.send('mainprocess-response', "Đã gửi yêu cầu tới máy chủ cục bộ của Liên Minh")

                    resJson = resJson.filter(x => x.owned == true && x.name != "" && x.subInventoryType == "")

                    /**
                     * Remove duplicates
                     */
                    let SkinsList = []
                    for (let object of resJson) {
                        if (SkinsList.find(x => x.name.trim() == object.name.trim()) != null) {
                            continue
                        }

                        SkinsList.push(object)
                    }


                    event.sender.send('mainprocess-response-skin', `Đã nhận danh sách trang phục. Bạn đang sở hữu <strong>${SkinsList.length}</strong> trang phục`)

                    const wb = new xl.Workbook()
                    const ws = wb.addWorksheet('LCU Result')

                    const headingColumnNames = [
                        "#",
                        "Tên trang phục",
                        "Giá trang phục",
                        "Là di sản hoặc giới hạn?",
                        "Ngày sở hữu"
                    ]

                    let headingColumnIndex = 1
                    headingColumnNames.forEach(heading => {
                        ws.cell(1, headingColumnIndex++).string(heading)
                    })

                    let rowIndex = 2, index = 0;
                    for (let skin of SkinsList) {
                        let skin_prices = 0

                        let findPrices = SkinsList.find(x => x.itemId == skin.itemId && x.prices.length > 0)
                        if (typeof findPrices != "undefined") {
                            skin_prices = findPrices.prices[0].cost
                        }

                        let purchasedTime = (new Date(SkinsList.find(x => x.itemId == skin.itemId).purchaseDate * 1000)).toLocaleString("vi-vn", { timeZone: "Asia/Ho_Chi_Minh" }).replace(/\,/, " ")
                        purchasedTime = purchasedTime.split("  ")
                        let purchasedDate = purchasedTime[1]
                        purchasedDate = purchasedDate.split("/").map(x => {
                            return (parseInt(x) < 10) ? "0" + x : x
                        })

                        ws.cell(rowIndex, 1).number(++index)
                        ws.cell(rowIndex, 2).string(skin.name)
                        ws.cell(rowIndex, 3).number(skin_prices)
                        ws.cell(rowIndex, 4).string((skin.active) ? "Không" : "Có")
                        ws.cell(rowIndex, 5).string(`${purchasedTime[0].trim()} ${purchasedDate.join("/")}`)

                        rowIndex++

                    }

                    if (!fs.existsSync("./export")) {
                        fs.mkdirSync("./export")
                    }

                    wb.write(`./export/${SummonerName}-Skins-List-${(new Date()).getTime()}.xlsx`)

                    event.sender.send('mainprocess-response', "Danh sách trang phục đã được tạo")
                } catch {
                    event.sender.send('mainprocess-response-error', "Không tìm thấy LeagueClient.exe hoạt động")
                }
            })()
            break

        case "get_loot_analyst":
            (async function () {
                try {
                    const credentials = await authenticate()

                    const response = await request({
                        method: 'GET',
                        url: '/lol-loot/v1/player-loot'
                    }, credentials)

                    let resJson = await response.json()

                    /** 
                     * @alias [S]kins
                     * @alias [W]ards
                     * @alias [E]motes
                     **/
                    let
                        totalS = {
                            RP: 0,
                            OE: 0,
                            SK: 0
                        },
                        totalW = {
                            RP: 0,
                            OE: 0,
                            WR: 0
                        },
                        totalE = {
                            RP: 0,
                            OE: 0,
                            EM: 0
                        },
                        skinRarity = {
                            MYTHIC: 0,
                            ULTIMATE: 0,
                            LEGENDARY: 0,
                            EPIC: 0,
                            DEFAULT: 0
                        }

                    for (let item of resJson) {
                        if (item.displayCategories == "SKIN") {
                            totalS.SK += item.count
                            totalS.RP += item.value
                            totalS.OE += item.disenchantValue

                            skinRarity[item.rarity] += (1 * item.count)
                        }

                        if (item.displayCategories == "WARDSKIN") {
                            totalW.WR += item.count
                            totalW.RP += item.value
                            totalW.OE += item.disenchantValue
                        }

                        if (item.displayCategories == "EMOTE") {
                            totalE.EM += item.count
                            totalE.RP += item.value
                            totalE.OE += item.disenchantValue
                        }
                    }

                    event.sender.send('mainprocess-analyst-result', {
                        totalS, totalW, totalE, skinRarity
                    })

                    event.sender.send('mainprocess-response', "Hoàn thành thống kê")
                } catch {
                    event.sender.send('mainprocess-response-error', "Không tìm thấy LeagueClient.exe hoạt động")
                }
            })()
            break

        case "request_start_auto_champ_select":
            AutoSelectChampion.status = true
            AutoSelectChampion.championId = parseInt(arg.championId)

            event.sender.send('mainprocess-response', "Đã khởi động auto")
            break

        case "request_stop_auto_champ_select":
            AutoSelectChampion.status = false
            AutoSelectChampion.championId = 0

            event.sender.send('mainprocess-response', "Đã tạm dừng auto")
            break

        case "request_summoner":
            (async function () {
                try {
                    const credentials = await authenticate()
                    const response = await request({
                        method: 'GET',
                        url: '/lol-summoner/v1/current-summoner'
                    }, credentials)

                    const summoner = await response.json()

                    SummonerId = summoner.summonerId
                    SummonerName = summoner.displayName

                    if (IsFirstStart) {
                        StartGamePhaseistener(credentials)
                        StartLeagueClientListener(credentials)
                    }

                    IsFirstStart = false

                    event.sender.send('mainprocess-response-summoner', SummonerName)
                } catch (error) {
                    console.log(error)
                    event.sender.send('mainprocess-response-error', "Vui lòng khởi động Liên Minh Huyền thoại")

                    let interval = setInterval(async () => {
                        try {
                            const credentials = await authenticate()

                            const response = await request({
                                method: 'GET',
                                url: '/lol-summoner/v1/current-summoner'
                            }, credentials)

                            const summoner = await response.json()

                            SummonerName = summoner.displayName

                            if (typeof SummonerName != "undefined" || SummonerName != "undefined") {
                                SummonerId = summoner.summonerId

                                if (IsFirstStart) {
                                    StartGamePhaseistener(credentials)
                                    StartLeagueClientListener(credentials)
                                }

                                IsFirstStart = false

                                event.sender.send('mainprocess-response-summoner', SummonerName)

                                clearInterval(interval)
                            }
                        } catch { }
                    }, 3000)
                }
            })()
            break;
    }
});

function createWindow() {
    const win = new BrowserWindow({
        width: 800,
        height: 600,
        resizable: true,
        title: "Loading...",
        backgroundColor: '#2c3e50',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    })

    win.setMenu(null)
    win.loadFile('index.html')

    //win.webContents.openDevTools()
}

app.whenReady().then(() => {
    createWindow()

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
})

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit()
})