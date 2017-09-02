
net = require('net')

const benDecode = require('bencode').decode 
const benEncode = require('bencode').encode
const async = require('async')

EventEmitter = require('events').EventEmitter

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

const NUM_REQUESTS_PER_PEER = 5
const NUM_OUTSTANDING_REQS = 200
const NUM_ACTIVE_PIECES = 12
const NUM_CONNECTIONS = 50

var byFreq2 = ( arrSet ) => {

	let freqs = new Map()

	for(var set of arrSet) {

		for(var pIdx of set) {

			let count = freqs.get(pIdx)
			if(count || count == 0)
				freqs.set(pIdx, count++)
			else 
				freqs.set(pIdx, 1) 

		}
	}

	return Array.from(freqs.entries()).sort( (p1, p2) => p1[1] - p2[1]).map( tuple => tuple[0] )

}

class Swarm extends EventEmitter {

	constructor(fileMetaData, download, myIP, myPort) {

		super()

		this.peerStats = new NMap()
		this.peers = new NSet()//new NMap()
		
		this.fileMetaData = fileMetaData
		this.download = download

		this.defaultTimeout = 3 * 1e3
		
		this.myIP = myIP
		this.myPort = myPort

		let self = this

		this.listeners = {

			'connected' : ( peer ) => {

				let stats = self.peerStats

				if(!stats.has(peer.peerID)) 
					stats.set(peer.peerID, {'uploadedTime' : 0, 'downloadTime' : 0,'uploadBytes': 0, 'downloadBytes': 0,
						'disconnects' : 0, 'firstConnect' : Date.now()})

				self.emit('peer_connected')

			},

			'disconnected' : ( peer ) => {

				console.log("deleting", peer.peerID)

				if(self.peers.has(peer))
					self.peers.delete(peer)

				if(self.peerStats.has(peer.peerID))
					self.peerStats.get(peer.peerID).disconnects++

				self.emit('peer_disconnected')

			}, 

			'new_peers' : () => { 

				self.emit('new_peers') 

			},

			'peer_interested' : () => {

				self.emit('peer_interested')

			},

			'peer_unchoked' : () => {

				self.emit('peer_unchoked')

			},

			'peer_choked' : () => {

				self.emit('peer_choked')

			},

			'new_pieces' : (peer) => {

				self.emit('new_pieces')

			},
 
			'peer_piece' : (peer, index, begin, piecelet) => { 
			
				let stats = self.peerStats.get(peer.peerID)
				console.log(peer.uploadBytes)
				stats.uploadTime = peer.uploadTime
				stats.uploadBytes = peer.uploadBytes

			},

			'piece_sent' : ( peer ) => {

				let stats = self.peerStats.get(peer.peerID)
				stats.downloadTime = peer.downloadTime//+= uploadTime
				stats.downloadBytes = peer.downloadBytes //+= piecelet.length

			}

		}

		var sockOpts = {'allowHalfOpen' : false, 'pauseOnConnect' : true}

		//this.UTPserver = uTP.createServer() // ...
		//let self = this

		this.TCPserver = net.
		createServer(sockOpts, ( sock ) => {
			
			console.log("server connection", sock.remoteAddress, sock.remotePort)
			let peer = this.makePeer(sock)
			
			peer.on('connected', (peer) => {

				self.emit('new_peer', peer)

			})

		}).listen(this.myPort)

		this.on('new_peer', (peer) => {
			//if(!self.peers.has(peer))
			self.peers.add(peer)
		})

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
			peer.on(event, listeners[event])
		
	}


	checkPeerID(peerID) { //maybe keep registry of peerIDs and addresses ?
		console.log('every:', Array.from(this.peers).every( peer => peer.peerID != peerID) )
		console.log('my ip', peerID != this.download.peerID)
		return Array.from(this.peers).every( peer => peer.peerID != peerID) && peerID != this.download.peerID

	}

	connectPeer (addr) {
		
		return new Promise((resolve, reject) => {

			let peer = this.makePeer(null, addr).handshake()
		
			let timeout = setTimeout(()=> {

				reject("peer timeout")

			}, this.defaultTimeout)

			peer.on('connected', (peer) => { //after recieving handshake

				clearTimeout(timeout)
				console.log('resolve peer', peer.peerID)
				resolve(peer)

			})

			peer.on('reject id', (peer) => {

				clearTimeout(timeout)
				reject(new Error('rejected id'))

			})
			
		})
	}

	addPeers (addrs) {
		console.log('addpeer')
		let self = this
		var _addPeer = async function (addr, callback) {

			try {

				let peer = await self.connectPeer(addr)
				self.peers.add(peer)

			} catch (error) {

				console.log(error)

			}

			callback()
			
		}

		async.each(addrs, _addPeer, function (err) {

			self.emit('new_peers')

		})

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

	//set of peers that have index piece
	peersWithPiece(index, peers) {

		//peers = peers || this.peers
		return peers.filter( peer => peer.pieces.has(index))

	}

	//set of pieces these peers have difference pieces arg
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

		return this.peers.filter(peer => !peer.isSeeder())//.getSet()

	}

	get seeders() {

		return this.peers.filter( peer => peer.isSeeder())//.getSet()

	}

	get optimisticUnchokePeers () {

		return this.peers.filter( peer => peer.optUnchoke )//.getSet()

	}

	get unchokedPeers () {

		return this.peers.filter( peer => !peer.choked)//.getSet()

	}

	get chokedPeers () {

		return this.peers.difference(this.unchokedPeers)

	}

	get amUnchokedPeers () {

		return this.peers.filter( peer => !peer.pChoked)//.getSet()

	}

	get amChokedPeers () {

		return this.peers.difference(this.amUnchokedPeers)

	}

	get interestedPeers () {

		return this.peers.filter( peer => peer.interested)//.getSet()

	}

	get aInterestedPeers () {

		return this.peers.filter(peer => peer.aInterested)//.getSet()

	}

	get unInterestedPeers () {

		return this.peers.difference(this.interestedPeers)

	}
	 
	get amInterestedPeers () {

		return this.peers.filter( peer => peer.pInterested)//.getSet()

	}

	get amUnInterestedPeers () {

		return this.peers.difference(this.amInterestedPeers)

	}

	get metaInfoExPeers () {

		return this.peers.filter( peer => peer.supportedExtensions['ut_metadata'])//.getSet()

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
	
	this.requests = []

	this.activePieces = new Map()
	this.pieces = new Map()
	this.seeding = false

	this.fileMetaData = {

		'peerID' : this.peerID, //kill
		'activePieces' : this.activePieces, //kill
		'pieces' : this.pieces, //pieces this peer has //kill
		//////////////////////////////////////////////////////////////////////
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
		'pieceHashes' : []

	}

	let self = this, file = this.fileMetaData

	this.stats = {

		get downloaded() { return self.pieces.has(file.numPieces - 1) ? (file.pieces.size - 1) * file.pieceLength +  file.fileLength % file.pieceLength : file.pieces.size * file.pieceLength },
		get left() { return file.fileLength - self.stats.downloaded} ,
		get uploaded() { return 0 },
		ev : 2 //???

	}

	this.download = {

		peerID : this.peerID,
		pieces : this.pieces,
		activePieces : this.activePieces,
		seeding : this.seeding,
		stats : this.stats

	}

	this.swarm = new Swarm(this.fileMetaData, this.download, this.myIP, this.myPort)

	this.swarm.listeners['peer_request'] = async (peer, index, begin, length) => {  //fulfill all requests from unchoked peers

			let piece = self.pieces.get(index)
			let buf = await piece.readPiecelet(begin, length)
			peer.piece(index, begin, buf)

	}	

	this.swarm.listeners['peer_piece'] = (peer, index, begin, piecelet) => { 

		if(!self.activePieces.has(index))
			return

		let piece = self.activePieces.get(index)
		piece.add(index, begin, piecelet)

		let pos = self.requests.findIndex( req => req.index == index && req.begin == begin && req.length == piecelet.length )
		if(pos != -1)
			 clearTimeout(self.requests[pos].timeout)

		self.requests = this.requests.filter( req => req.index != index && req.begin != begin && req.length != piecelet.length)

		if(piece.isComplete && piece.assemble()) { //copy to disk		
			
			console.log(Math.floor(self.pieces.size / self.fileMetaData.numPieces * 100), '% | Got piece:', index)
			self.activePieces.delete(index)
			self.pieces.set(index, new self.Piece(index))
			self.swarm.havePiece(index)
							
			if(self.pieces.size == self.fileMetaData.numPieces) {
				self.seeding = true
				self.seed()	
				return	
			} 

			self.emit('recieved_piece') //call downloadPiece before downloadPiecelet

		} 

		self.emit('recieved_piecelet')
				
	}

}

util.inherits(Downloader, EventEmitter)

Downloader.prototype.setMetaInfoFile = async function (metaInfoFilePath) {
	
	if(!fs.existsSync(metaInfoFilePath))
		return

	let metaData = fs.readFileSync(metaInfoFilePath)
	let deMetaData = benDecode(metaData)
	let {announce, info} = deMetaData

	let announceList = deMetaData['announce-list']
	//console.log(announceList)
	this.trackerless = ! (announceList || announce)
	
	if(!this.trackerless) {
		this.fileMetaData.announceUrlList = Array.isArray(announce) ? announce.map( url => url.toString()) : [announce.toString()]

		//console.log(announceList.map( url => url[0].toString()) )
		this.fileMetaData.announceUrlList = this.fileMetaData.announceUrlList.concat( announceList.map( url => url[0].toString()) )
		//console.log(this.fileMetaData.announceUrlList)
	}
	
	return await this.setMetaInfo(benEncode(info))
	
}

Downloader.prototype.setMagnetUri = function(magnetUri) {

	if(magnetUri.slice(0, 8) != "magnet:?")
		throw new Error()

	let {xt, dn, tr} = querystring.parse(magnetUri.slice(8))
	
	let file = this.fileMetaData
	file.infoHash = xt.slice(9)
	file.name = dn
	file.announceUrlList = tr
	this.trackerless = !!tr

}

Downloader.prototype.setMetaInfo = async function (info) {

	let fileMetaData = this.fileMetaData

	fileMetaData.metaInfoRaw = info
	fileMetaData.metaInfoSize = info.length
	fileMetaData.infoHash = new Buffer(crypto.createHash('sha1').update(info).digest('hex'), 'hex')
	//fileMetaData.date = ['creation date']

	let m = benDecode(info)
	fileMetaData.name = m.name.toString()
	fileMetaData.pieceLength = m['piece length']
	fileMetaData.pieceHashes = m.pieces.toString('hex').match(/.{40}/g) //string or buffer ???

	if(m.length) {

		fileMetaData.isDirectory = false
		fileMetaData.fileLength = m.length
		fileMetaData.fileLengthList = [fileMetaData.fileLength]
		fileMetaData.path = "./" + fileMetaData.name
		fileMetaData.pathList = [ fileMetaData.path ]
		console.log('pathList', fileMetaData.pathList)

	} else { 

		fileMetaData.isDirectory = true
		fileMetaData.fileLengthList = m.files.map( pairs => pairs.length )
		fileMetaData.fileLength = fileMetaData.fileLengthList.reduce( (a, b) => a + b, 0)
		fileMetaData.pathList = m.files.map( pairs => pairs.path ).map( name => './' + name)

	}

	fileMetaData.numPieces = Math.ceil( fileMetaData.fileLength / fileMetaData.pieceLength) 

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

	//magnet:?xt=urn:btih:9401adf4f356feb3c629b3757f6d71430052fc8c&dn=c_primer_5th_edition.pdf
	//dont start until metaData filled - pieces checked
	console.log('Starting...')

	if (this.seeding)
		this.seed()
	else
		this.leech()

}

Downloader.prototype.leech = function() {

	clearInterval(this.sloop)
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
	this.swarm.on('peer_choked', (this.downloadPieces).bind(this)) //kill - taken care of by updateActivePieces

}

Downloader.prototype.seed = function () {

	clearInterval(this.uLoop)
	//clear listeners ??

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
			return (p1Stats.downloadBytes / p1Stats.downloadBytes) < (p2Stats.downloadBytes / p2Stats.downloadBytes)

		})
		//console.log("unchokeCandidates:", unchokeCandidates)
		for(let numUnchoked = 0; numUnchoked < 12 && unchokeCandidates.length > 0; numUnchoked++) { //maybe add randomness ??

			candidate = unchokeCandidates.shift()
			//console.log("Unchoking:", candidate)
			if(candidate.choked) //if already unchoked do nothing
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
	
		let unchokeCandidates = Array.from(interestedAndChoked).sort( (p1, p2) => (peerMap.get(p1.peerID).firstConnect) < (peerMap.get(p2.peerID).firstConnect ) )
		//!!!!!!!!! should favor new peers !!!!!!!!!!!
		
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

		return (p1Stats.uploadBytes/p1Stats.uploadTime) < (p2Stats.uploadBytes/ p2Stats.uploadTime)

	})

	//chose best and unchoke
	let numUnchoked = 0 //amUnchoked.size
	while(numUnchoked < 8 && unchokeCandidates.length > 0) {

		candidate = unchokeCandidates.shift()
		if(candidate.choke) //if already unchoked do nothing
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

	//console.log('downloadPieces')

	var maxActivePieces = () => {
		
		let left = this.fileMetaData.numPieces - this.pieces.size 
		return left >= 10 ? 10 : left

	}

	//call on no activePieces, leeching and connected to ->interested amUnchoked peers

	//actually interested, amUnchoked peers
	peers = this.swarm.amUnchokedPeers.intersection(this.swarm.aInterestedPeers) //amInterestedPeers
	//delete activePieces that no peer has 

	if( !(this.activePieces.size < maxActivePieces()))
		return this.downloadPiecelets()

	//no unchoked and no active pieces - create active piece from amongst pieces connected peers have
	if(this.swarm.amUnchokedPeers.size == 0 && this.activePieces.size == 0)
		peers = this.swarm.aInterestedPeers

	/////////////////
	hist = this.swarm.piecesByFreq2(peers)
	hist = hist.filter( x => x || (x == 0) && true )
	hist = hist.filter(x => x < this.fileMetaData.numPieces)
	this.bar = hist
	///////////////
	//this.pieces.size + this.activePieces.size < this.fileMetaData.numPieces
	while( this.activePieces.size < maxActivePieces() && hist.length > 0 && this.pieces.size < this.fileMetaData.numPieces ) {//} && i++ < 1100) {

		let randArrIdx = Math.floor(Math.pow(Math.random(), 3) * hist.length)
		let pIndex = hist[randArrIdx]
		this.activePieces.set(Number(pIndex), new this.ActivePiece(Number(pIndex)))
		this.swarm.peers.forEach( peer => peer.updateInterested() )
	}

	this.downloadPiecelets()

	//download pieces from mutually unchoked peers in group (1) and amUnchoked peers in group (3)

}

Downloader.prototype.downloadPiecelets = function() {

	//call on no reqs, leeching and connected to ->interested amUnchoked peers
	//call on req timeout
	//call on req completion 

	let swarm = this.swarm, requests = this.requests, peers = swarm.amUnchokedPeers.intersection(swarm.interestedPeers)

	this.requests.filter( request => request.peer.pChoked ).forEach( req => { clearTimeout(req.timeout); req.putBack(req) } )
	this.requests = this.requests.filter( request => !request.peer.pChoked )

	if(peers.size == 0) 
		return

	let self = this

	var reqToPeer = (( peer, req ) => {

		req.timeout = setTimeout(()=> {

			req.putBack(req); 
			self.requests.splice(self.requests.findIndex(requests => requests == req), 1)
			self.emit('request_timeout') 

		}, 30 * 1e3)

		req.peer = peer
		this.requests.push(req)

		peer.request(req.index, req.begin, req.length)

	}).bind(this)

	var randReqToPeer = ((peer) => {

		if(!peer)
			return null

		let pieceletReq, randomIndex, piece
		let pieces = peer.pieces.intersection(new NSet(this.activePieces.keys()))

		if(pieces.size == 0)
			return null

		let pieceList = Array.from(pieces)

		do { //randomly select piece, get piecelet or if no piecelet then repeat

			randomIndex = Math.floor(Math.random() * pieceList.length) //maybe favour pieces that idle peers have ??
			piece = Array.from(pieces)[randomIndex]
			pieceletReq = this.activePieces.get(piece).randPieceletReq()

			if(!pieceletReq)
				pieceList.splice(randomIndex, 1)

		} while (!pieceletReq && pieceList.length > 0) 

		if(pieceletReq) 
			reqToPeer( peer, pieceletReq )

		return pieceletReq

	}).bind(this)

	//always interested in these peers
	while(this.requests.length < peers.size * 4 && peers.size > 0 && this.activePieces.size > 0 ) {//  && i++ < 2000) {

		//randomly select peer - more heavily weight idle peers
		let rand = Math.random()
		let randPeer = Array.from(peers)[Math.floor(rand) * peers.size]	

		for(var i = 0 ; i < 4; i++) {

			if(!randReqToPeer(randPeer) ) {//no more piecelets

				peers.delete(randPeer) //just delete or remove
				break

			}
		}
	}

	//enough outstanding requests or no piecelets for active pieces ...

}

Downloader.prototype.pruneConn = function() {

	//disconnect peers that are seeding if seeding
	//disconnect peers that refuse requests
	//disconnect peers that never unchoke even when interested (in me)

	//get connections under limit by randomly disconnecting slow peers or infrequent or short time unchokers (1)
	//peer leeching but mutually uninterested

	//average total bandwidth available
	// Z peeri * upload speed < average total bandwidth
	//randomly disconnect one at a time from(1) and monitor download speed - stop when download speed decreases

}

Downloader.prototype.addPeers = function(peers) {

	//if(this.seeding)
	//	return

	peers = peers.map( (tuple) => { return { host : tuple.ip, port : tuple.port } } )
	//apply filters

	if(!peers)
		return
	peers = peers.filter(peer => Array.from(this.swarm.peers).every(oPeer => oPeer.port != peer.port && oPeer.host != peer.host))
	
	console.log('Connecting:', peers)

	let self = this
	
	this.swarm.addPeers(peers)

	this.pruneConn()

}

Downloader.prototype.DHTAnnounce = async function() {

	let dht = this.dht || new DHT(this.dhtPort, "")
	dht.bootstrap()

	let peerList = await dht.announce(this.fileMetaData.infoHash, this.myPort)
	this.addPeers(peerList)

}

Downloader.prototype.announce = async function() {
	
	let infoHash = this.fileMetaData.infoHash
	let peerID = this.peerID

	//let sock = await getUDPSocket() 
	
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
			console.log('peers returned:', peerList)
			//callback(null, )

		} catch(error) {

			console.log(error)

		} 

	}).bind(this)

	async.each( this.fileMetaData.announceUrlList, _annnounce, function (err, callback) {})

}


class Client {

	constructor() {

		this.downloadeders = []
	}

	addTorrent() {

		let downloader = new Downloader()

		downloader.setMetaInfoFile()
		this.downloadeders.push(downloadeder)
	}

}

module.exports = {
	'Swarm' : Swarm,
	'Downloader' : Downloader
}

