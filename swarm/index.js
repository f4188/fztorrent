
const benDecode = require('bencode').decode 
const benEncode = require('bencode').encode
const async = require('async')
const speedometer = require('speedometer')
EventEmitter = require('events').EventEmitter
const randomAccessFile = require('random-access-file')

const NSet = require('../lib/NSet.js').NSet
const NMap = require('../lib/NSet.js').NMap
const ActivePieces = require('./piece.js').ActivePieces
const Pieces = require('./piece.js').Pieces
const UDPTracker = require('../tracker/index.js').UDPTracker
const HTTPTracker = require('../tracker/index.js').HTTPTracker
const DHT = require('../dht/index.js').DHT

_Peer = require('../peer/index.js').Peer
const UTMetaDataEx = require('../metadata_exchange/index.js').UTMetaDataEx
Peer = UTMetaDataEx(_Peer)

const MAX_NUM_PEERSTATS = 2000
const NUM_REQUESTS_PER_PEER = 2
const NUM_REQUESTS_TOTAL = 200
const NUM_ACTIVE_PIECES = 50
const SOFT_MIN_CONNECTIONS = 50
const HARD_MAX_CONNECTIONS = 100
const MAX_NUM_OPT_UNCHOKE = 4
const MAX_NUM_MUTUAL_UNCHOKE = 10

f = fs.createWriteStream('./meta')

var byFreq2 = ( arrSet ) => {

	let freqs = new Map()

	for(var set of arrSet) 
		for(var pIdx of set) {

			let count = freqs.get(pIdx)
			if(count || count == 0)
				freqs.set(pIdx, ++count)
			else 
				freqs.set(pIdx, 0) 

		}

	return Array.from(freqs.entries()).sort( (p1, p2) => p1[1] - p2[1])
}

class Swarm extends EventEmitter {

	constructor(fileMetaData, download, myIP, myPort) {

		super()

		this.peerStats = new NMap()
		this.peers = new NSet()//new NMap()
		this.connLoop = null
		this.acceptServerConn = true
		
		this.fileMetaData = fileMetaData
		this.download = download

		this.defaultTimeout = 3 * 1e3
		
		this.myIP = myIP
		this.myPort = myPort

		this.startTime = null

		let self = this

		this.listeners = {

			'connected' : [( peer ) => {
			//	console.log('connected', peer.peerID)
				self.peers.add(peer)

				if(!self.peerStats.has(peer.peerID)) {

					let stats =  { 'disconnects' : 0, 'firstConnect' : Date.now(), host : peer.sock.remoteAddress, 
						port : peer.sock.remotePort, status : 1, online : 1, dSpeed : speedometer(60), 
						downRate : 0, uSpeed : speedometer(60), upRate : 0 }

					self.peerStats.set(peer.peerID, stats)
					self.peerStats.set(stats.host + ":" + stats.port, stats)

					peer.sock.on('data', (data) => { stats.downRate = stats.dSpeed(data.length) } )
					peer.on('data', (data) => { stats.upRate = stats.uSpeed(data.length) } )

				}

				else 
					self.peerStats.get(peer.peerID).status = 1

				self.emit('new_peer', peer)


			}],

			'disconnected' : [( peer ) => {
			//	console.log('disconnected', peer.peerID)
				self.peers.delete(peer)
				self.peerStats.get(peer.peerID).disconnects++
				self.peerStats.get(peer.peerID).status = 0
				self.emit('peer_disconnected')

			}], 

			'peer_interested' : [() => {

				self.emit('peer_interested')

			}],

			'peer_unchoked' : [() => {

				self.emit('peer_unchoked')

			}],

			'peer_choked' : [() => {

				self.emit('peer_choked')

			}],

			'new_pieces' : [(peer) => {

				self.emit('new_pieces')

			}],

		}

		var sockOpts = {'allowHalfOpen' : false, 'pauseOnConnect' : true}

		//this.UTPserver = uTP.createServer() // ...

		this.TCPserver = net.createServer(sockOpts, ( sock ) => {
			
			console.log("server connection", sock.remoteAddress, sock.remotePort)
			self.pruneConnections(true)

			if(self.connectMorePeersCond() > 0 && this.acceptServerConn)
				self.makePeer(sock)

		}).listen(this.myPort)

	}

	start(seeding) {

		this.seeding = seeding
		this.connLoop = setInterval( (this.connectManager).bind(this), 60 * 1e3 )

	}

	//disconnect peers that are seeding if seeding
	//disconnect peers that refuse requests
	//disconnect peers that never unchoke even when interested (in me)

	//get connections under limit by randomly disconnecting slow peers or infrequent or short time unchokers (1)
	//peer leeching but mutually uninterested

	//average total bandwidth available
	// Z peeri * upload speed < average total bandwidth
	//randomly disconnect one at a time from(1) and monitor download speed - stop when download speed decreases

	//called periodically and also when new peers available
	pruneConnections(avail) { //prunes idle or bad peers - peers that never unchoke despite interest - slow peers 

		let self = this, seeding = this.seeding

		//average rate to top five downloaders 
		if(avail || (this.peers.size > 50  )) { //be liberal 

			let fiveRate = this.peerStats.filter(x => x.status == 1).getArray().map( x => x.downRate ).sort( (s1, s2) => s2 - s1 ).slice(0, 10)
			fiveRate = fiveRate.reduce( (sum, rate) => sum + rate, 0) / 10

			this.peers.forEach( peer => {

				let stats = self.peerStats.get(peer.peerID)
				let time = Date.now - stats.firstConnect

				if(!seeding && time > 60 * 1e3  && stats.downRate < fiveRate / 5 ) //prune by percentile ?? 
					peer.sock.end()
				if(seeding && time > 60 * 1e3 && stats.upRate < 1e3) 
					peer.sock.end()

			})
			

		}

	}

	connectManager(starting) {
	//	console.log('connect manager')
		let self = this

		var _addPeer = async function (addr, callback) {

			try {

				let peer = await self.connectPeer(addr)
				self.peers.add(peer)

			} catch (error) {

			}

			callback()
		
		}

		this.pruneConnections(true)

		let numAddrs = this.connectMorePeersCond()

		if(numAddrs > 0) {

			if(starting) 
				numAddrs = 200

			let addrs = this.peerStats.filter( stat => stat.online == 1 && stat.status == 0 && stat.disconnects == null).getArray()
			addrs = Array.from(new NSet(addrs))
			addrs = addrs.slice(0, numAddrs)
			async.each(addrs, _addPeer, (err) => { self.emit('new_peers') })

		}



	}

	connectMorePeersCond () {

		return Math.max(50 - this.peers.size, 15 - this.amUnchokedPeers.size, 25 - this.aInterestedPeers.size, 0)
	
	}

	makePeer(sock, addr) {

		if(!sock) {

			let sockOpts = { 'allowHalfOpen' : false }
			sock = new net.Socket(sockOpts)
			sock.connect(addr.port, addr.host)		

		}

		let peer = new Peer(this.fileMetaData, this.download, sock, (this.checkPeerID).bind(this))
		this.addListeners(peer, this.listeners)

		return peer

	}

	addListeners(peer, listeners) {

		for( var event in listeners)
			for( var listener in listeners[event])
				peer.on(event, listeners[event][listener])
		
	}


	checkPeerID(peerID) {

		return Array.from(this.peers).every( peer => peer.peerID != peerID) && peerID != this.download.peerID

	}

	connectPeer (addr) {
		
		let self = this
		return new Promise((resolve, reject) => {

			let peer = this.makePeer(null, addr).handshake()
		
			peer.timeout = setTimeout(()=> {

				let stat = self.peerStats.get(addr.host + ":" + addr.port)
				if(stat) stat.online = 0
				reject(new Error("peer timeout"))

			}, this.defaultTimeout)

			peer.on('connected', (peer) => {

				clearTimeout(peer.timeout)
				resolve(peer)

			})

			peer.on('reject id', (peer) => {

				clearTimeout(peer.timeout)
				reject(new Error('rejected id'))

			})
			
		})
	}

	addPeers (addrs) {

		addrs = addrs.filter(addrs => Array.from(this.peers).every(oPeer => oPeer.port != addrs.port && oPeer.host != addrs.host))
		
		for(var addr of addrs) {
			
			if( !this.peerStats.has(addr.host + ":" + addr.port) )
				this.peerStats.set(addr.host + ":" + addr.port, { disconnects : null, host : addr.host, port : addr.port, online : 1 , status : 0})

		}

		this.connectManager()

		if(this.peerStats.size > 2000) {
			//sort by oldest first connect - kill never connected
			//kill zero download if leeching or zero upload if seeding
			//kill slow peers
		}

	}

	piecesByFreq2 (peers) {

		peers = peers || this.peers
		let file = this.fileMetaData, peerPieceSet = []
		let myPieces = (new NSet(file.pieces.keys())).union(new NSet(file.activePieces.keys()))
 
		for( var peer of peers) {
			peerPieceSet.push(this.allPieces(new NSet([peer]), myPieces))
		}

		return byFreq2(peerPieceSet)

	}

	peersWithPiece(index, peers) {

		return peers.filter( peer => peer.pieces.has(index))

	}

	allPieces(peers, pieces) {

		peers = peers || this.peers
		pieces = pieces || new NSet()
		let allPieces = new NSet()

		for( let peer of peers ) {
			allPieces = allPieces.union(peer.pieces.difference(pieces))
		}

		return allPieces
	}


	havePiece(index) {

		this.peers.forEach( peer => peer.have(index) )
		this.peers.forEach( peer => peer.updateInterested() )		

	}

	get leechers() {

		return this.peers.filter(peer => !peer.isSeeder())

	}

	get seeders() {

		return this.peers.filter( peer => peer.isSeeder())

	}

	get optimisticUnchokePeers () {

		return this.peers.filter( peer => peer.optUnchoke )

	}

	get unchokedPeers () {

		return this.peers.filter( peer => !peer.choked)

	}

	get chokedPeers () {

		return this.peers.difference(this.unchokedPeers)

	}

	get amUnchokedPeers () {

		return this.peers.filter( peer => !peer.pChoked)

	}

	get amChokedPeers () {

		return this.peers.difference(this.amUnchokedPeers)

	}

	get interestedPeers () {

		return this.peers.filter( peer => peer.interested)

	}

	get aInterestedPeers () {

		return this.peers.filter(peer => peer.aInterested)

	}

	get unInterestedPeers () {

		return this.peers.difference(this.interestedPeers)

	}
	 
	get amInterestedPeers () {

		return this.peers.filter( peer => peer.pInterested)

	}

	get amUnInterestedPeers () {

		return this.peers.difference(this.amInterestedPeers)

	}

	get metaInfoExPeers () {

		return this.peers.filter( peer => peer.supportedExtensions['ut_metadata'])

	}

}

function Downloader(myPort, peerID) { //extends eventEmitter

	EventEmitter.call(this)

	this.myIP = ""
	this.myPort = myPort //listen port for new peers
	this.peerID = Buffer.concat( [Buffer.from('-fz1000-', 'ascii'), crypto.randomBytes(12)] ).toString('hex')

	this.uLoop = null
	this.optLoop = null
	this.sLoop = null
	this.annLoop = null

	this.announceUrlList = []
	this.trackers = []

	this.trackerless = false
	this.dht = null
	this.dhtPort = 6881
	this.enableDHT = false
	this.dht = null
	
	this.requests = []

	this.activePieces = new NMap()
	this.pieces = new Map()
	this.seeding = false

	this.fileMetaData = {

		'peerID' : this.peerID, //kill
		'activePieces' : this.activePieces, //kill
		'pieces' : this.pieces, //pieces this peer has //kill
		'announceUrlList' : [], 
		'date' : "", 
		'infoHash' : null,
		'metaInfoSize' : null,
		'name' : "",
		'pathList' : [],
		'fileLength' : null, 
		'fileLengthList': [],
		'numPieces' : null,
		'pieceLength' : null,
		'pieceHashes' : [],
		'ready' : false

	}

	let self = this, file = this.fileMetaData

	this.stats = {

		get downloaded() { return self.pieces.has(file.numPieces - 1) ? (file.pieces.size - 1) * file.pieceLength +  file.fileLength % file.pieceLength : file.pieces.size * file.pieceLength },
		get left() { return file.fileLength - self.stats.downloaded} ,
		get uploaded() { return 0 },
		ev : 2 //???

	}

	this.download = {

		ready : false,
		peerID : this.peerID,
		pieces : this.pieces,
		activePieces : this.activePieces,
		seeding : this.seeding,
		stats : this.stats

	}

	this.swarm = new Swarm(this.fileMetaData, this.download, this.myIP, this.myPort)

	//connected/disconnected/peer_interested/peer_unchoked/peer_choked/new_pieces
	this.swarm.listeners['got_meta_data'] = [ ( async (buf) => { 
		console.log('got metadata')
		if(this.fileMetaData.metaInfoRaw)
			return
		console.log('set metadata')
		this.fileMetaData.metaInfoRaw = buf
		let seeding = await this.setMetaInfo(buf)
		this.fileMetaData.ready = true
		if(!seeding)
			this.downloadPieces() 

	}).bind(this) ]

	this.swarm.listeners['connected'].push( (peer) => { peer.requestList = [] })

	this.swarm.listeners['connected_extensions'] = [(peer) => { 

		if(!self.fileMetaData.metaInfoRaw)
			peer.init() 

	}]

	this.swarm.listeners['peer_choked'].push( (peer) => {  

		peer.requestList.forEach( req => {

			clearTimeout(req.timeout)
			req.putBack()

		})

		peer.requestList = []

	})

	this.swarm.listeners['peer_request'] = [async (peer, index, begin, length) => {  //fulfill all requests from unchoked peers

			let piece = self.pieces.get(index)
			let buf = await piece.readPiecelet(begin, length)
			peer.piece(index, begin, buf)

	}]	

	this.swarm.listeners['peer_piece'] = [(peer, index, begin, piecelet) => { 

		if(!self.activePieces.has(index))
			return

		
		let pos = peer.requestList.findIndex( req => req.index == index && req.begin == begin && req.length == piecelet.length)
		
		if(pos != -1)
			peer.requestList.splice(pos, 1)
		
		let piece = self.activePieces.get(index)
		piece.add(index, begin, piecelet)

		if(piece.isComplete && piece.assemble()) {
			
		//	console.log(Math.floor(self.pieces.size / self.fileMetaData.numPieces * 100), '% | Got piece:', index, "|" ,peer.peerID)
			self.activePieces.delete(index)
			self.pieces.set(index, new self.Piece(index))
			self.swarm.havePiece(index)
							
			if(self.pieces.size == self.fileMetaData.numPieces) {
				self.seeding = true
				self.seed()	
				return	
			} 

			self.emit('recieved_piece') 

		} 

		self.emit('recieved_piecelet')
				
	}]

}

util.inherits(Downloader, EventEmitter)

Downloader.prototype.setMetaInfoFile = async function (metaInfoFilePath) {
	
	if(!fs.existsSync(metaInfoFilePath))
		return

	let metaData = fs.readFileSync(metaInfoFilePath)
	let deMetaData = benDecode(metaData)
	let {announce, info} = deMetaData

	let announceList = deMetaData['announce-list']
	this.trackerless = ! (announceList || announce)
	
	if(!this.trackerless) {
		this.fileMetaData.announceUrlList = Array.isArray(announce) ? announce.map( url => url.toString()) : [announce.toString()]
		if(announceList)
			this.fileMetaData.announceUrlList = this.fileMetaData.announceUrlList.concat( announceList.map( url => url[0].toString()) )
	}
	
	fileMetaData.metaInfoRaw = info
	let seeding = await this.setMetaInfo(benEncode(info))
	fileMetaData.ready = true
	return seeding
	
}

Downloader.prototype.setMagnetUri = function(magnetUri) {

	if(magnetUri.slice(0, 8) != "magnet:?")
		throw new Error()

	
	let {xt, dn, tr} = querystring.parse(magnetUri.slice(8))
	
	let file = this.fileMetaData
	file.infoHash = Buffer.from(xt.slice(9), 'hex')
	file.name = dn
	file.announceUrlList = Array.isArray(tr) ? tr : [tr]
	this.trackerless = !tr //need to get metaData

}

Downloader.prototype.setMetaInfo = async function (info) {

	let fileMetaData = this.fileMetaData

	fileMetaData.metaInfoSize = info.length
	fileMetaData.infoHash = new Buffer(crypto.createHash('sha1').update(info).digest('hex'), 'hex')
	//fileMetaData.date = ['creation date']

	let m = benDecode(info)
	fileMetaData.name = m.name.toString()
	fileMetaData.pieceLength = m['piece length']
	fileMetaData.pieceHashes = m.pieces.toString('hex').match(/.{40}/g)

	if(m.length) {

		fileMetaData.isDirectory = false
		fileMetaData.fileLength = m.length
		fileMetaData.fileLengthList = [fileMetaData.fileLength]
		fileMetaData.path = "./" + fileMetaData.name
		fileMetaData.pathList = [ fileMetaData.path ]
		console.log('pathList', fileMetaData.pathList)

	} else { 

		fileMetaData.isDirectory = true
		fileMetaData.fileLengthList = m.files.map( pair => pair.length )
		fileMetaData.fileLength = fileMetaData.fileLengthList.reduce( (sum, b) => sum + b, 0)
		fileMetaData.pathList = m.files.map( pair => pair.path ).map( name => './' + name)
		console.log(fileMetaData.fileLength)
		console.log(fileMetaData.fileLengthList)
		console.log(fileMetaData.pathList)
		console.log(fileMetaData.pieceLength)

	}

	fileMetaData.files = fileMetaData.pathList.map( path => randomAccessFile(path) )
	fileMetaData.numPieces = Math.ceil( fileMetaData.fileLength / fileMetaData.pieceLength) 
	console.log(fileMetaData.numPieces)
	console.log(m)


	this.Piece = Pieces(fileMetaData)
	this.ActivePiece = ActivePieces(fileMetaData)

	for(let idx = 0; idx < fileMetaData.numPieces; idx ++ ) {

		let piece = new this.Piece(idx)
		if(await piece.verify()) {
			this.pieces.set(idx, piece)
		}

	}

	console.log('Have', Math.floor(this.pieces.size / this.fileMetaData.numPieces * 100), "% of pieces.")
	this.seeding = this.pieces.size == fileMetaData.numPieces
	return this.seeding

}

Downloader.prototype.getMetaData = function() {

}

Downloader.prototype.start = async function() {

	//console.log('Starting...')
	this.swarm.startTime = Date.now()

	if (this.seeding)
		this.seed()
	else
		this.leech()

}

Downloader.prototype.leech = function() {

	clearInterval(this.sLoop)
	this.announceLoop()
	this.annLoop = setInterval((this.announceLoop).bind(this), 300 * 1e3)

	let self = this 

	var updateActivePieces = () => {
	
		let peers = self.swarm.amUnchokedPeers.intersection(self.swarm.aInterestedPeers) //if small then add peers from aInterested
		if(peers.size == 0) 
			peers = self.swarm.aInterestedPeers 

		//for(peer of peers) {
		for(index of self.activePieces.keys()) {
			if(self.swarm.peersWithPiece(index, peers).size == 0) 
				self.activePieces.delete(index)
		}

	}	

	this.swarm.on('peer_disconnected', updateActivePieces )	
	this.swarm.on('peer_choked', updateActivePieces )

	//this.on('new_peers', (this.optUnchokeLoop).bind(this))
	this.swarm.on('peer_interested', (this.optUnchokeLoop).bind(this))
	this.optLoop = setInterval((this.optUnchokeLoop).bind(this), 30 * 1e3)
	//this.on('new_peers', (this.unchokeLoop).bind(this))
	this.swarm.on('peer_interested', (this.unchokeLoop).bind(this))
	this.swarm.on('peer_unchoked', (this.unchokeLoop).bind(this))
	//this.swarm.on()
	this.uLoop = setInterval((this.unchokeLoop).bind(this), 10 * 1e3)

	this.on('recieved_piece', (this.downloadPieces).bind(this))
	this.on('recieved_piecelet', (this.downloadPiecelets).bind(this))
	this.on('request_timeout', (this.downloadPieces).bind(this))
	this.on('request_timeout', (this.downloadPiecelets).bind(this))

	this.swarm.on('new_pieces', (this.downloadPieces).bind(this)) //aInterested
	this.swarm.on('peer_unchoked', (this.downloadPieces).bind(this)) //amUnChoked
	//this.swarm.on('peer_choked', (this.downloadPieces).bind(this)) //kill - taken care of by updateActivePieces

}

Downloader.prototype.seed = function () {

	clearInterval(this.uLoop)
	//disconnect seeders

	this.announceLoop()
	this.annLoop = setInterval((this.announceLoop).bind(this), 300 * 1e3) 

	this.on('new_peers', (this.optUnchokeLoop).bind(this))
	this.optLoop = setInterval((this.optUnchokeLoop).bind(this), 30 * 1e3)

	this.on('new_peers', (this.seedLoop).bind(this))
	this.sLoop = setInterval((this.seedLoop).bind(this), 30 * 1e3)

}

Downloader.prototype.announceLoop = function() {
	
	if(this.enableDHT || this.trackerless)
		this.DHTAnnounce()	
	
	if(!this.trackerless)
		this.announce()

}

Downloader.prototype.seedLoop = function() {

		let swarm = this.swarm
		let peerMap = this.swarm.peerStats

		swarm.leechers.intersection(swarm.amUnInterestedPeers).intersection(swarm.unchokedPeers).forEach( peer => peer.choke() )

		let interestedPeers = swarm.leechers.intersection(swarm.amInterestedPeers)

		let unchokeCandidates = Array.from(interestedPeers).sort( (p1, p2) => {

			let p1Stats = peerMap.get(p1.peerID), p2Stats = peerMap.get(p2.peerID)
			return p1Stats.upRate - p2Stats.upRate

		})

		for(let numUnchoked = 0; numUnchoked < 12 && unchokeCandidates.length > 0; numUnchoked++) { //maybe add randomness ??

			candidate = unchokeCandidates.shift()

			if(candidate.choked)
				candidate.unchoke()

		}

		let self = this
		unchokeCandidates.filter(peer => !peer.choked).forEach( peer => peer.choke())

}

Downloader.prototype.optUnchokeLoop = function() {

		//pick opts unchoke -- 3
		//optUnchoke randomly but give weight to new peers
		//this.optimisticUnchokePeers
		if(this.seeding) {

		}

		let swarm = this.swarm, peerMap = this.swarm.peerStats
		let interestedAndChoked = swarm.leechers.intersection(swarm.interestedPeers).intersection(swarm.chokedPeers)

		swarm.optimisticUnchokePeers.forEach( peer => peer.choke() )
	
		let unchokeCandidates = Array.from(interestedAndChoked).sort( (p1, p2) => (peerMap.get(p2.peerID).firstConnect) - (peerMap.get(p1.peerID).firstConnect ) )
		
		for(let numUnchoked = 0; numUnchoked < 3 && unchokeCandidates.length > 0; numUnchoked++) { //maybe add randomness ??

			let randIdx = Math.floor(Math.random() ** 2 * unchokeCandidates.length)
			let candidate = unchokeCandidates[randIdx]
			candidate.unchoke()

		}

}

Downloader.prototype.unchokeLoop = function() {

	let swarm = this.swarm

	//choke any peer that chokes me and is not opt unchoke
	let peers = swarm.leechers.difference(swarm.optimisticUnchokePeers)
	let unchoked = peers.intersection(swarm.unchokedPeers)

	let self = this
	unchoked.intersection(swarm.amChokedPeers).forEach( peer => peer.choke() )
	
	//mutually interested peers -- initially near zero --- must add group (3) peers when sending requests
	let mutuallyInterestedPeers = swarm.leechers.intersection(swarm.interestedPeers).intersection(swarm.amInterestedPeers).difference(swarm.optimisticUnchokePeers)

	let amUnchoked = mutuallyInterestedPeers.intersection(swarm.amUnchokedPeers)

	let peerMap = this.swarm.peerStats
	let unchokeCandidates = Array.from(amUnchoked).sort( (p1, p2) => {

		let p1Stats = peerMap.get(p1.peerID), p2Stats = peerMap.get(p2.peerID)

		return p1Stats.downRate - p2Stats.downRate

	})

	let numUnchoked = 0 
	while(numUnchoked < 8 && unchokeCandidates.length > 0) {

		candidate = unchokeCandidates.shift()
		if(candidate.choke)
			candidate.unchoke()
		numUnchoked++

	}

	//choke rest of candidates
	unchokeCandidates.filter(peer => !peer.choked).forEach( peer => peer.choke())

	if(numUnchoked < 8) { // 
		//maybe optimistically unchoke more candidates
		//so 8 mutually unchoked and 2 opt unchoked
		//if 8 - k mutually unchoked then 2 + k opt unchoked ??
	}

	//download from amUnchoked peers - includes peers unchoked here 
	//plus group peers that have chosen me as opt unchoke (amOpt) - group (3) plus some group (1) peers

}

//piece downloader - only called when pieces available
Downloader.prototype.downloadPieces = function() {

	if(!this.fileMetaData.ready) //no requests unless have metaInfo
		return

	var maxActivePieces = () => {
		//this.pieces.size + this.activePieces.size < this.fileMetaData.numPieces
		let left = this.fileMetaData.numPieces - this.pieces.size 
		return left >= NUM_ACTIVE_PIECES ? NUM_ACTIVE_PIECES : left

	}

	peers = this.swarm.amUnchokedPeers.intersection(this.swarm.aInterestedPeers)

	if( !(this.activePieces.size < maxActivePieces()))
		return this.downloadPiecelets()

	//no unchoked and no active pieces - create active piece from amongst pieces connected peers have
	if(this.swarm.amUnchokedPeers.size == 0 && this.activePieces.size == 0)
		peers = this.swarm.aInterestedPeers

	/////////////////
	hist = this.swarm.piecesByFreq2(peers).map( tuple => tuple[0] )
	hist = hist.filter( x => x || (x == 0))
	hist = hist.filter(x => x < this.fileMetaData.numPieces)
	///////////////

	while( this.activePieces.size < maxActivePieces() && hist.length > 0 && this.activePieces.size < hist.length &&  this.pieces.size < this.fileMetaData.numPieces ) {
		//console.log('looping', maxActivePieces(), this.activePieces.size, hist.length, this.fileMetaData.numPieces)
		//f.write('download pieces' + )
		//console.log(hist)
		let randArrIdx = Math.floor(Math.pow(Math.random(), 3) * hist.length)
		let pIndex = hist[randArrIdx]
		this.activePieces.set(Number(pIndex), new this.ActivePiece(Number(pIndex)))
		this.swarm.peers.forEach( peer => peer.updateInterested() )
	}

	this.downloadPiecelets()
	//download pieces from mutually unchoked peers in group (1) and amUnchoked peers in group (3)

}

Downloader.prototype.downloadPiecelets = function() { 

	let swarm = this.swarm, requests = this.requests, peers = swarm.amUnchokedPeers.intersection(swarm.interestedPeers)

	if(peers.size == 0) 
		return

	let self = this

	var randReqToPeer = ((peer) => {

		if(!peer)
			return null

		let pieceletReq, randomIndex, piece
		let pieces = peer.pieces.intersection(new NSet(this.activePieces.keys()))

		if(pieces.size == 0)
			return null

		let pieceList = Array.from(pieces)

		do { //randomly select piece, get piecelet or if no piecelet then repeat
			//console.log('getting piecelet')
			randomIndex = Math.floor(Math.random() * pieceList.length) //maybe favour pieces that idle peers have ??
			piece = Array.from(pieces)[randomIndex]
			pieceletReq = this.activePieces.get(piece).randPieceletReq(peer)

			if(!pieceletReq)
				pieceList.splice(randomIndex, 1)

		} while (!pieceletReq && pieceList.length > 0) 

		if(pieceletReq) {
			peer.requestList.push(pieceletReq)
			peer.request(pieceletReq)
		}

		return pieceletReq

	}).bind(this)
	
	let peersWithOutstandingReq = new NSet(this.requests.map( req => req.peer ) )
	let peersWithFourOutstandingReq = peersWithOutstandingReq.filter( peer => this.requests.reduce( (count, req) => req.peer == peer ? (count + 1): count, 0) > 1 )
	peers = peers.difference(peersWithFourOutstandingReq)

	//while(this.activePieces.getArray().map(piece => piece.requests.length).reduce((sum, numReqs) => sum + numReqs, 0) > 0  && peers.size > 0 && this.activePieces.size > 0 ) {
	while(this.activePieces.getArray().map(piece => piece.requestsLeft()).reduce((sum, numReqs) => sum + numReqs, 0) > 0  && peers.size > 0 && this.activePieces.size > 0 ) {
		console.log('looping 2', peers.size, this.activePieces.size, this.activePieces.getArray().map(piece => piece.requestsLeft()).reduce((sum, numReqs) => sum + numReqs, 0) )
		let rand = Math.random()
		let randPeer = Array.from(peers)[Math.floor(rand) * peers.size]	

		if( randPeer.requestList.length > 1 || !randReqToPeer(randPeer) ) //no more piecelets or more than 4 req
			peers.delete(randPeer) 

	}

}

Downloader.prototype.addPeers = function(peers) {

	peers = peers.map( (tuple) => { return { host : tuple.ip, port : tuple.port } } )
	this.swarm.addPeers(peers)

}

Downloader.prototype.DHTAnnounce = async function() {

	let dht 
	if(!this.dht) {
		this.dht = new DHT(this.dhtPort, "")
		//dht.bootstrap() //loadDHT
		this.dht.loadDHT()
	}

	dht = this.dht

	let peerList = await dht.announce(this.fileMetaData.infoHash, this.myPort)
	console.log(peerList)
	this.addPeers(peerList)

}

Downloader.prototype.announce = async function() {
	
	let infoHash = this.fileMetaData.infoHash
	let peerID = this.peerID
	
	var _annnounce = (async function (announceUrl, callback) {
		
		let u = new url.URL(announceUrl)
		let resp, tracker = this.trackers[u.href]

		if(!tracker) {

			if(u.protocol == 'udp:')	
				tracker = new UDPTracker(u, infoHash, Buffer.from(peerID,'hex'), this.download.stats)
				
			else if (u.protocol == 'http:')
				tracker = new HTTPTracker(this.fileMetaData, this.download, u)

			this.trackers.push(tracker)

		}
		
		try {

			resp = await tracker.doAnnounce(this.myPort)
			let { numLeechers, numSeeders, interval, peerList } = resp

			this.addPeers(peerList || [])
			console.log("Tracker:", announceUrl)
			console.log("leechers:", numLeechers)
			console.log('seeders:', numSeeders)
			console.log('peers returned:', peerList && peerList.length)

		} catch(error) {

			console.log(error)

		} 

	}).bind(this)

	async.each( this.fileMetaData.announceUrlList, _annnounce, function (err, callback) {})

}

class Torrent {

	constructor(downloader) {

		this.downloader = downloader

	}

	start() {

		this.downloader.start()

	}

	pause() {

		clearInterval(this.downloader.announceLoop)
		clearInterval(this.downloader.sLoop)
		clearInterval(this.downloader.optLoop)
		clearInterval(this.downloader.unchokeLoop)
		clearInterval(this.downloader.swarm.connectManager)
		this.downloader.swarm.acceptServerConn = false

	}

	resume() {}

	stop() {

		this.pause()
		let peers = this.downloader.swarm.peers
		peers.forEach( peer => peer.sock.end())
		peers.clear()
		this.downloader.activePieces.clear()

	}

	delete() {}

	priority() {}

	verify() {}

	progress() {}

	connections() {}

}

class Client {

	constructor() {

		this.torrents = []
	}

	addTorrent(str) {

		//check uri or filepath
		//if invalid uri or file throw error
		//if neighter ...

		let downloader = new Downloader()
		downloader.setMetaInfoFile()
		downloader.swarm.start() //starts connection manager loop

		let torrent = new Torrent(downloader)
		this.torrents.push(torrent)
		return torrent

	}

	getTorrent() {} 

	status() {}

}

module.exports = {
	'Swarm' : Swarm,
	'Downloader' : Downloader
}

