all:
	make clean; make build; cp dist/* ../public
		
clean:
	rm -f ./dist/*

build:
	docker build --output ./dist .